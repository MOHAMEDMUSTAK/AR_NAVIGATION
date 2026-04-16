// gps.js — Precision Sensor Engine v4
// Kalman Filter + Separated Display Position + Road Quality + Battery
// FIXES: position not updating, Kalman drift, walking-speed dead reckoning

window.GPS = {
    // Raw Kalman-filtered GPS position (never touched by dead reckoning)
    currentLat: null, currentLon: null, currentAccuracy: 999,
    // Display position (smoothly interpolated for rendering — DR updates this only)
    displayLat: null, displayLon: null,
    speed: 0, heading: 0, smoothHeading: 0, bearing: 0, altitude: 0,
    initialized: false, listeners: [], watchId: null, active: false,

    // Kalman state — pure GPS only
    kalman: { lat: { x:0, p:1, q:0.00001, r:0.0001, k:0, init:false }, lon: { x:0, p:1, q:0.00001, r:0.0001, k:0, init:false } },

    lastUpdateTime: 0, lastDRTime: 0, lastRawLat: null, lastRawLon: null, drId: null,
    lastNotifyTime: 0,

    // Road quality
    accelSamples: [], roughRoadCooldown: 0,

    // Trip stats
    tripDistance: 0, tripStartTime: 0, maxSpeed: 0, speedSamples: [],
    
    // Speed computation fallback
    lastSpeedLat: null, lastSpeedLon: null, lastSpeedTime: 0,

    async init() {
        if (this.initialized) return;
        this.active = true;

        // Compass
        if (window.DeviceOrientationEvent) {
            if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                try { 
                    const p = await DeviceOrientationEvent.requestPermission(); 
                    if (p === 'granted') window.addEventListener('deviceorientation', this._handleOrientation = this.handleOrientation.bind(this)); 
                } catch(e){}
            } else {
                window.addEventListener('deviceorientation', this._handleOrientation = this.handleOrientation.bind(this));
            }
        }

        // GPS — get cached position first for instant start, then refine
        if ("geolocation" in navigator) {
            // Quick coarse fix
            try {
                navigator.geolocation.getCurrentPosition(
                    this.updatePosition.bind(this),
                    () => {},
                    { enableHighAccuracy: false, maximumAge: 30000, timeout: 3000 }
                );
            } catch(e) {}
            
            // Continuous high-accuracy tracking
            this.watchId = navigator.geolocation.watchPosition(
                this.updatePosition.bind(this),
                this.handleError.bind(this),
                { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
            );
        } else throw new Error("Geolocation not supported.");

        // Dead reckoning at 60fps (requestAnimationFrame)
        this.active = true;
        this._drLoop = this.drLoop.bind(this);
        requestAnimationFrame(this._drLoop);


        // Accelerometer for road quality
        this.initAccelerometer();

        // Battery monitor
        this.initBattery();

        this.tripStartTime = Date.now();

        return new Promise((resolve, reject) => {
            let att = 0;
            const chk = setInterval(() => {
                att++;
                if (this.currentLat !== null) { 
                    clearInterval(chk); 
                    this.initialized = true; 
                    resolve(); 
                }
                if (att > 80) { 
                    clearInterval(chk); 
                    if (this.currentLat !== null) { this.initialized = true; resolve(); } 
                    else reject(new Error("GPS lock failed. Please enable location or go outdoors.")); 
                }
            }, 100);
        });
    },

    // ── Kalman Filter (pure GPS updates only) ──
    kUpdate(state, measurement, accuracy) {
        if (!state.init) { 
            state.x = measurement; 
            state.p = accuracy * accuracy * 0.0000001; 
            state.init = true; 
            return state.x; 
        }
        // Adaptive process noise based on speed (tightened to fix "none is accurate" bouncy GPS)
        state.q = this.speed > 5 ? 0.000001 : this.speed > 1 ? 0.0000005 : 0.0000002;
        state.r = Math.max(0.00001, accuracy * accuracy * 0.00000001);
        state.p += state.q;
        state.k = state.p / (state.p + state.r);
        state.x += state.k * (measurement - state.x);
        state.p *= (1 - state.k);
        return state.x;
    },

    // ── Compass ──
    headingHistory: [],
    handleOrientation(e) {
        // At driving speed, trust GPS bearing instead of compass
        if (this.speed > 2.5) return;

        let h = e.webkitCompassHeading !== undefined ? e.webkitCompassHeading : 
                e.alpha !== null ? (360 - e.alpha) % 360 : null;
        if (h === null) return;
        
        // Stabilize heading with a 5-sample median/average filter
        this.headingHistory.push(h);
        if (this.headingHistory.length > 5) this.headingHistory.shift();
        
        // Circular mean calculation for heading stability
        let sumX = 0, sumY = 0;
        this.headingHistory.forEach(val => {
            const rad = val * Math.PI / 180;
            sumX += Math.cos(rad);
            sumY += Math.sin(rad);
        });
        const stableHeading = (Math.atan2(sumY, sumX) * 180 / Math.PI + 360) % 360;
        
        this.heading = stableHeading;
        let d = this.heading - this.smoothHeading;
        if (d > 180) this.smoothHeading += 360; 
        else if (d < -180) this.smoothHeading -= 360;
        
        // Responsive but smooth alpha (0.2 for quick response, 0.05 for high stability)
        const alpha = this.speed > 0.5 ? 0.25 : 0.12; 
        this.smoothHeading += alpha * (this.heading - this.smoothHeading);
        
        if (this.smoothHeading >= 360) this.smoothHeading -= 360; 
        else if (this.smoothHeading < 0) this.smoothHeading += 360;

        this.notifyListeners('heading', this.smoothHeading);
    },

    // ── GPS Position Update ──
    updatePosition(pos) {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const acc = pos.coords.accuracy || 15;
        
        // Reject wildly inaccurate readings
        if (acc > 500) return;

        this.currentAccuracy = acc;

        // Compute bearing from consecutive raw GPS points
        if (this.lastRawLat !== null) {
            const d = this.qDist(this.lastRawLat, this.lastRawLon, lat, lon);
            if (d > 1.5) {
                this.bearing = this.calcBearing(this.lastRawLat, this.lastRawLon, lat, lon);
                
                // At any movement speed, use GPS bearing for heading
                if (this.speed > 1.0 || d > 3) {
                    this.heading = this.bearing;
                    this.smoothHeading = this.bearing;
                    this.notifyListeners('heading', this.smoothHeading);
                }
            }
            // Trip distance tracking
            if (d > 1 && d < 500) this.tripDistance += d;
        }
        this.lastRawLat = lat; 
        this.lastRawLon = lon;

        // Pure Kalman filter on GPS only (no DR contamination)
        this.currentLat = this.kUpdate(this.kalman.lat, lat, acc);
        this.currentLon = this.kUpdate(this.kalman.lon, lon, acc);
        
        // Initialize displayLat only once. DR smooths it! Jumpy hard-snaps are bad.
        if (this.displayLat === null) {
            this.displayLat = this.currentLat;
            this.displayLon = this.currentLon;
        }

        // Speed — prefer GPS speed, fallback to computed
        if (pos.coords.speed !== null && pos.coords.speed >= 0) {
            this.speed = pos.coords.speed;
        } else {
            // Compute speed from position deltas
            const now = Date.now();
            if (this.lastSpeedLat !== null && now - this.lastSpeedTime > 500) {
                const dt = (now - this.lastSpeedTime) / 1000;
                const dist = this.qDist(this.lastSpeedLat, this.lastSpeedLon, lat, lon);
                if (dt > 0 && dist < 200) {
                    this.speed = dist / dt;
                }
            }
            this.lastSpeedLat = lat;
            this.lastSpeedLon = lon;
            this.lastSpeedTime = now;
        }

        if (pos.coords.altitude !== null) this.altitude = Math.round(pos.coords.altitude);

        // Max speed / samples
        const kmh = this.speed * 3.6;
        if (kmh > this.maxSpeed) this.maxSpeed = kmh;
        this.speedSamples.push(kmh);
        if (this.speedSamples.length > 500) this.speedSamples.shift();

        this.lastUpdateTime = Date.now();
        this.lastDRTime = Date.now();
        
        // Throttle notifications to max 10/sec to prevent UI flooding
        this.throttledNotify();
    },

    // ── Dead Reckoning (updates displayLat/Lon ONLY — never Kalman state) ──
    drLoop() {
        if (!this.active) return;
        this.deadReckon();
        requestAnimationFrame(this._drLoop);
    },

    deadReckon() {
        if (!this.initialized || this.speed < 0.1) { 
            this.lastDRTime = performance.now(); 
            return; 
        }
        const now = performance.now();
        let dt = (now - (this.lastDRTime || this.lastUpdateTime)) / 1000;
        this.lastDRTime = now;
        if (dt <= 0 || dt > 1) return;

        // ACCURACY UPGRADE: Predictive heading integration
        const hr = this.smoothHeading * Math.PI / 180;
        const dist = this.speed * dt;
        const R = 6378137;
        
        const dLat = (dist * Math.cos(hr)) / R * (180 / Math.PI);
        const dLon = (dist * Math.sin(hr)) / (R * Math.cos((this.displayLat || this.currentLat) * Math.PI / 180)) * (180 / Math.PI);
        
        if (this.displayLat !== null) {
            this.displayLat += dLat;
            this.displayLon += dLon;
            
            // Soft anchor DR to pure GPS to correct drift smoothly (5% correction per frame)
            if (this.currentLat !== null) {
                this.displayLat += (this.currentLat - this.displayLat) * 0.05;
                this.displayLon += (this.currentLon - this.displayLon) * 0.05;
            }
        }
        
        // At 60fps, we notify at the same rate for peak fluidity
        this.throttledNotify();
    },

    
    // ── Throttled notify — optimized for 60fps rendering ──
    throttledNotify() {
        const now = performance.now();
        // Reduced throttle to 60fps (16ms) instead of 15fps
        if (now - this.lastNotifyTime < 16) return;
        this.lastNotifyTime = now;

        
        const lat = this.displayLat || this.currentLat;
        const lon = this.displayLon || this.currentLon;
        if (lat === null) return;
        
        this.notifyListeners('position', { 
            lat, lon, 
            speed: this.speed, 
            accuracy: this.currentAccuracy, 
            altitude: this.altitude, 
            bearing: this.bearing 
        });
    },

    // ── Road Quality via Accelerometer (throttled) ──
    initAccelerometer() {
        if (!window.DeviceMotionEvent) return;
        
        let lastAccelTime = 0;
        window.addEventListener('devicemotion', (e) => {
            const now = Date.now();
            if (now - lastAccelTime < 100) return; // Max 10 samples/sec
            lastAccelTime = now;
            
            let mag;
            if (e.acceleration && e.acceleration.x !== null) {
                mag = Math.sqrt(e.acceleration.x**2 + e.acceleration.y**2 + e.acceleration.z**2);
            } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null) {
                const ag = e.accelerationIncludingGravity;
                mag = Math.abs(Math.sqrt(ag.x**2 + ag.y**2 + ag.z**2) - 9.81);
            } else return;

            this.accelSamples.push(mag);
            if (this.accelSamples.length > 20) this.accelSamples.shift();

            // Road quality detection
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
        const avgSpd = this.speedSamples.length > 0 ? this.speedSamples.reduce((a,b) => a+b, 0) / this.speedSamples.length : 0;
        return {
            distance: (this.tripDistance / 1000).toFixed(1),
            duration: this.fmtDur(dur),
            avgSpeed: Math.round(avgSpd),
            maxSpeed: Math.round(this.maxSpeed)
        };
    },

    fmtDur(s) { 
        const m = Math.floor(s/60), h = Math.floor(m/60); 
        return h > 0 ? `${h}:${(m%60).toString().padStart(2,'0')}` : `${m}:${Math.round(s%60).toString().padStart(2,'0')}`; 
    },

    // ── Utils ──
    calcBearing(a, b, c, d) { 
        const p1 = a*Math.PI/180, p2 = c*Math.PI/180, dl = (d-b)*Math.PI/180; 
        return (Math.atan2(Math.sin(dl)*Math.cos(p2), Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl)) * 180/Math.PI + 360) % 360; 
    },
    
    qDist(a, b, c, d) { 
        const R = 6378137, dLat = (c-a)*Math.PI/180, dLon = (d-b)*Math.PI/180, co = Math.cos((a+c)/2*Math.PI/180); 
        return Math.sqrt((dLat*R)**2 + (dLon*co*R)**2); 
    },
    
    handleError(e) { console.error('GPS:', e.message); },
    onUpdate(cb) { this.listeners.push(cb); },
    notifyListeners(t, v) { for (let i = 0; i < this.listeners.length; i++) this.listeners[i](t, v); },

    destroy() {
        if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
        if (this.drId) clearInterval(this.drId);
        if (this._handleOrientation) window.removeEventListener('deviceorientation', this._handleOrientation);
        this.listeners = []; this.initialized = false; this.active = false;
        this.kalman.lat.init = false; this.kalman.lon.init = false;
        this.currentLat = null; this.currentLon = null; 
        this.displayLat = null; this.displayLon = null;
        this.watchId = null; this.drId = null;
        this.tripDistance = 0; this.maxSpeed = 0; this.speedSamples = []; this.accelSamples = [];
    }
};
