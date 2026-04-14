// gps.js — Ultra-Precision Sensor Engine v3
// Kalman Filter + Dead Reckoning + Road Quality Detection + Battery Monitor

window.GPS = {
    currentLat: null, currentLon: null, currentAccuracy: 999,
    speed: 0, heading: 0, smoothHeading: 0, bearing: 0, altitude: 0,
    alpha: 0.3, initialized: false, listeners: [], watchId: null,

    kalman: { lat: { x:0,p:1,q:.00001,r:.0001,k:0 }, lon: { x:0,p:1,q:.00001,r:.0001,k:0 }, init: false },

    lastUpdateTime: 0, lastDRTime: 0, lastRawLat: null, lastRawLon: null, drId: null,
    
    // Road quality
    accelSamples: [], roughRoadCooldown: 0,

    // Trip stats
    tripDistance: 0, tripStartTime: 0, maxSpeed: 0, speedSamples: [],

    async init() {
        if (this.initialized) return;

        // Compass
        if (window.DeviceOrientationEvent) {
            if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                try { const p = await DeviceOrientationEvent.requestPermission(); if (p === 'granted') window.addEventListener('deviceorientation', this.handleOrientation.bind(this)); } catch(e){}
            } else {
                window.addEventListener('deviceorientation', this.handleOrientation.bind(this));
            }
        }

        // GPS
        if ("geolocation" in navigator) {
            this.watchId = navigator.geolocation.watchPosition(
                this.updatePosition.bind(this),
                this.handleError.bind(this),
                { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
            );
        } else throw new Error("Geolocation not supported.");

        // Dead reckoning 60FPS for flawless visual AR rendering
        this.drId = setInterval(() => this.deadReckon(), 16);

        // Accelerometer for road quality detection
        this.initAccelerometer();

        // Battery monitor
        this.initBattery();

        this.tripStartTime = Date.now();

        return new Promise((resolve, reject) => {
            let att = 0;
            const chk = setInterval(() => {
                att++;
                if (this.currentLat !== null) { clearInterval(chk); this.initialized = true; resolve(); }
                if (att > 50) { clearInterval(chk); if (this.currentLat !== null) { this.initialized = true; resolve(); } else reject(new Error("GPS lock failed. Please enable location or go outdoors.")); }
            }, 100);
        });
    },

    // ── Kalman ──
    kUpdate(s, m, acc, processBoost) {
        if (!s.init) { s.x = m; s.p = acc*acc*.0000001; s.init = true; return s.x; }
        s.q = (this.speed > 5 ? .0001 : .00001) + (processBoost || 0);
        s.r = Math.max(.00001, acc*acc*.00000001);
        s.p += s.q; s.k = s.p/(s.p+s.r); s.x += s.k*(m-s.x); s.p *= (1-s.k);
        return s.x;
    },

    // ── Compass ──
    handleOrientation(e) {
        // Ignore compass completely if driving (speed > ~7 km/h) — trust the mathematical GPS bearing
        if (this.speed > 2.0) return;

        let h = e.webkitCompassHeading !== undefined ? e.webkitCompassHeading : e.alpha !== null ? (360 - e.alpha) % 360 : null;
        if (h === null) return;
        this.heading = h;
        let d = this.heading - this.smoothHeading;
        if (d > 180) this.smoothHeading += 360; else if (d < -180) this.smoothHeading -= 360;
        this.smoothHeading += this.alpha * (this.heading - this.smoothHeading);
        if (this.smoothHeading >= 360) this.smoothHeading -= 360; else if (this.smoothHeading < 0) this.smoothHeading += 360;

        const arrow = document.getElementById('compass-arrow');
        if (arrow) arrow.style.transform = `rotate(${this.smoothHeading}deg)`;
        const hv = document.getElementById('heading-val');
        if (hv) { const dirs=['N','NE','E','SE','S','SW','W','NW']; hv.innerText = `${Math.round(this.smoothHeading)}° ${dirs[Math.round(this.smoothHeading/45)%8]}`; }
        this.notifyListeners('heading', this.smoothHeading);
    },

    // ── GPS ──
    updatePosition(pos) {
        const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy || 15;
        if (acc > 3500) return;

        this.currentAccuracy = acc;
        const dot = document.getElementById('accuracy-dot');
        if (dot) dot.className = 'accuracy-dot ' + (acc <= 5 ? 'accuracy-excellent' : acc <= 15 ? 'accuracy-good' : 'accuracy-poor');

        // Bearing
        if (this.lastRawLat !== null) {
            const d = this.qDist(this.lastRawLat, this.lastRawLon, lat, lon);
            if (d > 2) {
                this.bearing = this.calcBearing(this.lastRawLat, this.lastRawLon, lat, lon);
                
                // CRITICAL: Sensor Fusion Override
                if (this.speed > 2.0) {
                    this.heading = this.bearing;
                    // Snapping directly prevents any rotation lag while turning at speed
                    this.smoothHeading = this.bearing;
                    const arrow = document.getElementById('compass-arrow');
                    if (arrow) arrow.style.transform = `rotate(${this.smoothHeading}deg)`;
                    this.notifyListeners('heading', this.smoothHeading);
                }
            }
            // Trip distance
            if (d > 1 && d < 500) this.tripDistance += d;
        }
        this.lastRawLat = lat; this.lastRawLon = lon;
        
        let pBoost = 0;
        const dt = (Date.now() - (this.lastUpdateTime || Date.now())) / 1000;
        
        // 2D Kinematic Model: Project where we *expect* to be based on speed and heading 
        // to reduce visual latency in the Kalman filter.
        let rawAcc = acc;
        if (this.initialized && this.speed > 0.5 && dt > 0 && dt <= 2) {
            const hr = this.smoothHeading * Math.PI / 180, dist = this.speed * dt, R = 6378137;
            const dLat = (dist * Math.cos(hr)) / R * (180 / Math.PI);
            const dLon = (dist * Math.sin(hr)) / (R * Math.cos(this.currentLat * Math.PI / 180)) * (180 / Math.PI);
            this.kalman.lat.x += dLat; 
            this.kalman.lon.x += dLon;
            
            // At highway speeds, raw GPS can jump sideways. We mathematically force the Kalman filter
            // to distrust sudden GPS jumps and heavily trust the Dead Reckoning physical momentum.
            if (this.speed > 7) {
                rawAcc = Math.max(acc, this.speed * 2.5); // Artificially inflate GPS uncertainty
                pBoost = -0.00005; // Decrease process noise (trust physics more)
            } else {
                pBoost = 0.00005; // Normal slight boost for walking/city driving
            }
        }

        this.currentLat = this.kUpdate(this.kalman.lat, lat, rawAcc, pBoost);
        this.currentLon = this.kUpdate(this.kalman.lon, lon, rawAcc, pBoost);

        if (pos.coords.speed !== null && pos.coords.speed >= 0) this.speed = pos.coords.speed;
        if (pos.coords.altitude !== null) this.altitude = Math.round(pos.coords.altitude);

        // Max speed
        const kmh = this.speed * 3.6;
        if (kmh > this.maxSpeed) this.maxSpeed = kmh;
        this.speedSamples.push(kmh);
        if (this.speedSamples.length > 1000) this.speedSamples.shift();

        this.lastUpdateTime = Date.now();
        this.lastDRTime = Date.now();
        this.updateUI();
        this.notifyListeners('position', { lat: this.currentLat, lon: this.currentLon, speed: this.speed, accuracy: acc, altitude: this.altitude, bearing: this.bearing });
    },

    // ── Dead Reckoning ──
    deadReckon() {
        if (!this.initialized || this.speed < 0.5) { this.lastDRTime = Date.now(); return; }
        const now = Date.now();
        let dt = (now - (this.lastDRTime || this.lastUpdateTime)) / 1000;
        this.lastDRTime = now;
        if (dt <= 0 || dt > 2) return;
        
        // Physics IMU integration: Add raw hardware acceleration (v = u + at)
        let physSpeed = this.speed;
        if (this.recentIMUAccel && this.recentIMUAccel > 0.5) {
            physSpeed += (this.recentIMUAccel * dt * 0.6); 
        }

        const hr = this.smoothHeading * Math.PI / 180, dist = physSpeed * dt, R = 6378137;
        this.currentLat += (dist * Math.cos(hr)) / R * (180 / Math.PI);
        this.currentLon += (dist * Math.sin(hr)) / (R * Math.cos(this.currentLat * Math.PI / 180)) * (180 / Math.PI);
        this.updateUI();
        this.notifyListeners('position', { lat: this.currentLat, lon: this.currentLon, speed: this.speed, accuracy: this.currentAccuracy, altitude: this.altitude, bearing: this.bearing });
    },

    // ── Road Quality via Accelerometer ──
    initAccelerometer() {
        if (window.DeviceMotionEvent) {
            window.addEventListener('devicemotion', (e) => {
                let mag;
                if (e.acceleration && e.acceleration.x !== null) {
                    mag = Math.sqrt(e.acceleration.x**2 + e.acceleration.y**2 + e.acceleration.z**2);
                } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null) {
                    const ag = e.accelerationIncludingGravity;
                    mag = Math.abs(Math.sqrt(ag.x**2 + ag.y**2 + ag.z**2) - 9.81);
                } else return;

                this.accelSamples.push(mag);
                if (this.accelSamples.length > 20) this.accelSamples.shift();

                // Advanced IMU Physics
                if (!this.recentIMUAccel) this.recentIMUAccel = 0;
                this.recentIMUAccel = this.recentIMUAccel * 0.8 + mag * 0.2;

                // If average deviation from gravity is high = rough road
                if (this.accelSamples.length >= 15 && this.roughRoadCooldown <= 0) {
                    const avg = this.accelSamples.reduce((a, b) => a + b, 0) / this.accelSamples.length;
                    const rqEl = document.getElementById('road-quality');
                    if (avg > 3.5) {
                        if (rqEl) { rqEl.classList.remove('rq-hidden'); rqEl.classList.add('rq-visible'); document.getElementById('rq-text').innerText = '⚠️ Pothole / Bump!'; }
                        this.roughRoadCooldown = 50;
                        if (navigator.vibrate) navigator.vibrate(150);
                    } else if (avg > 2.0) {
                        if (rqEl) { rqEl.classList.remove('rq-hidden'); rqEl.classList.add('rq-visible'); document.getElementById('rq-text').innerText = '⚡ Rough Road'; }
                        this.roughRoadCooldown = 30;
                    } else {
                        if (rqEl) { rqEl.classList.remove('rq-visible'); rqEl.classList.add('rq-hidden'); }
                    }
                }
                if (this.roughRoadCooldown > 0) this.roughRoadCooldown--;
            });
        }
    },

    // ── Battery ──
    async initBattery() {
        try {
            if (navigator.getBattery) {
                const bat = await navigator.getBattery();
                const update = () => {
                    const lvl = Math.round(bat.level * 100);
                    const el = document.getElementById('battery-level-fill');
                    if (el) {
                        el.style.width = `${lvl}%`;
                        el.style.background = lvl > 20 ? '#00e676' : lvl > 10 ? '#ffaa00' : '#ff4444';
                    }
                };
                update();
                bat.addEventListener('levelchange', update);
            }
        } catch (e) {}
    },

    // ── Trip Stats ──
    getTripStats() {
        const dur = (Date.now() - this.tripStartTime) / 1000;
        const avgSpd = this.speedSamples.length > 0 ? this.speedSamples.reduce((a,b)=>a+b,0)/this.speedSamples.length : 0;
        return {
            distance: (this.tripDistance / 1000).toFixed(1),
            duration: this.fmtDur(dur),
            avgSpeed: Math.round(avgSpd),
            maxSpeed: Math.round(this.maxSpeed)
        };
    },

    fmtDur(s) { const m = Math.floor(s/60), h = Math.floor(m/60); return h > 0 ? `${h}:${(m%60).toString().padStart(2,'0')}` : `${m}:${Math.round(s%60).toString().padStart(2,'0')}`; },

    // ── UI ──
    updateUI() {
        const el = document.getElementById('telemetry-speed');
        if (el) el.innerText = Math.round(this.speed * 3.6);
        const alt = document.getElementById('altitude-display');
        if (alt) alt.innerText = `${this.altitude}m`;
    },

    // ── Utils ──
    calcBearing(a,b,c,d) { const p1=a*Math.PI/180,p2=c*Math.PI/180,dl=(d-b)*Math.PI/180; return (Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360; },
    qDist(a,b,c,d) { const R=6378137,dLat=(c-a)*Math.PI/180,dLon=(d-b)*Math.PI/180,co=Math.cos((a+c)/2*Math.PI/180); return Math.sqrt((dLat*R)**2+(dLon*co*R)**2); },
    handleError(e) { console.error('GPS:', e.message); },
    onUpdate(cb) { this.listeners.push(cb); },
    notifyListeners(t,v) { this.listeners.forEach(l=>l(t,v)); },

    destroy() {
        if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
        if (this.drId) clearInterval(this.drId);
        this.listeners=[]; this.initialized=false; this.kalman.init=false;
        this.currentLat=null; this.currentLon=null; this.watchId=null; this.drId=null;
        this.tripDistance=0; this.maxSpeed=0; this.speedSamples=[]; this.accelSamples=[];
    }
};
