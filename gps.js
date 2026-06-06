// gps.js — AstraNav Precision Sensor Engine v6
// Faster Kalman response, 30fps notify cap, improved heading fusion, capped DR correction

window.GPS = {
    currentLat: null, currentLon: null, currentAccuracy: 999,
    displayLat: null, displayLon: null,
    speed: 0, smoothSpeed: 0, heading: 0, smoothHeading: 0, bearing: 0, altitude: 0,
    initialized: false, listeners: [], watchId: null, active: false,

    kalman: {
        lat: { x: 0, p: 1, q: 0, r: 0, k: 0, init: false },
        lon: { x: 0, p: 1, q: 0, r: 0, k: 0, init: false }
    },

    lastUpdateTime: 0,
    lastDRTime: 0,
    lastRawLat: null, lastRawLon: null,
    lastNotifyTime: 0,
    lastSpeedLat: null, lastSpeedLon: null, lastSpeedTime: 0,
    speedHistory: [],

    // Road quality
    accelSamples: [], roughRoadCooldown: 0,

    // Trip stats
    tripDistance: 0, tripStartTime: 0, maxSpeed: 0, speedSamples: [],

    // Heading circular buffer (4 samples for extremely fast response)
    headingHistory: [],

    async init() {
        if (this.initialized) return;
        if (this.active) {
            return new Promise((resolve, reject) => {
                let att = 0;
                const chk = setInterval(() => {
                    att++;
                    if (this.currentLat !== null) { clearInterval(chk); this.initialized = true; resolve(); }
                    if (att > 80) { clearInterval(chk); if (this.currentLat !== null) { this.initialized = true; resolve(); } else reject(new Error('GPS lock failed.')); }
                }, 100);
            });
        }
        this.active = true;

        // Compass / DeviceOrientation
        if (window.DeviceOrientationEvent) {
            if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                try {
                    const p = await DeviceOrientationEvent.requestPermission();
                    if (p === 'granted') window.addEventListener('deviceorientation', this._handleOrientation = this.handleOrientation.bind(this));
                } catch (e) {}
            } else {
                window.addEventListener('deviceorientation', this._handleOrientation = this.handleOrientation.bind(this));
            }
        }

        // Quick coarse fix first
        if ('geolocation' in navigator) {
            try {
                navigator.geolocation.getCurrentPosition(
                    this.updatePosition.bind(this),
                    () => {},
                    { enableHighAccuracy: false, maximumAge: 60000, timeout: 3000 }
                );
            } catch (e) {}

            // High-accuracy continuous watch
            this.watchId = navigator.geolocation.watchPosition(
                this.updatePosition.bind(this),
                this.handleError.bind(this),
                { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
            );
        } else {
            throw new Error('Geolocation not supported.');
        }

        // Dead reckoning at display frame rate
        this._drLoop = this.drLoop.bind(this);
        this.lastDRTime = performance.now();
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
                if (this.currentLat !== null) { clearInterval(chk); this.initialized = true; resolve(); }
                if (att > 80) {
                    clearInterval(chk);
                    if (this.currentLat !== null) { this.initialized = true; resolve(); }
                    else reject(new Error('GPS lock failed. Enable location or go outdoors.'));
                }
            }, 100);
        });
    },

    // ── Adaptive Kalman Filter — Faster response at speed ──
    kUpdate(state, measurement, accuracy) {
        if (!state.init) {
            state.x = measurement;
            state.p = accuracy * accuracy * 0.0000001;
            state.init = true;
            return state.x;
        }
        // Process noise scales aggressively with speed for faster tracking
        state.q = this.speed > 15 ? 0.000005
                : this.speed > 8  ? 0.000003
                : this.speed > 3  ? 0.0000015
                : this.speed > 0.5 ? 0.0000005
                : 0.0000001;
        // Measurement noise from GPS accuracy
        state.r = Math.max(0.000000005, (accuracy * accuracy) * 0.000000001);
        state.p += state.q;
        state.k = state.p / (state.p + state.r);
        state.x += state.k * (measurement - state.x);
        state.p *= (1 - state.k);
        return state.x;
    },

    // ── Compass / Orientation ──
    handleOrientation(e) {
        // At driving speed trust GPS bearing more
        if (this.speed > 3.0) return;

        let h = e.webkitCompassHeading !== undefined ? e.webkitCompassHeading :
            e.alpha !== null ? (360 - e.alpha) % 360 : null;
        if (h === null) return;

        // Circular mean (6-sample buffer — faster response than 8)
        this.headingHistory.push(h);
        if (this.headingHistory.length > 4) this.headingHistory.shift();

        let sumX = 0, sumY = 0;
        for (let i = 0; i < this.headingHistory.length; i++) {
            const r = this.headingHistory[i] * Math.PI / 180;
            sumX += Math.cos(r);
            sumY += Math.sin(r);
        }
        const stableH = (Math.atan2(sumY, sumX) * 180 / Math.PI + 360) % 360;

        this.heading = stableH;
        let d = this.heading - this.smoothHeading;
        if (d > 180) d -= 360;
        else if (d < -180) d += 360;

        // Heading rate-of-change detector for sharp turns
        const isSharpTurn = Math.abs(d) > 15; // >15 deg per frame means very sharp turn
        const alpha = isSharpTurn ? 0.6 : (this.speed > 0.5 ? 0.25 : 0.12);

        this.smoothHeading += alpha * d;
        if (this.smoothHeading >= 360) this.smoothHeading -= 360;
        else if (this.smoothHeading < 0) this.smoothHeading += 360;

        this.notifyListeners('heading', this.smoothHeading);
    },

    // ── GPS Position Update ──
    updatePosition(pos) {
        const lat  = pos.coords.latitude;
        const lon  = pos.coords.longitude;
        const acc  = pos.coords.accuracy || 20;

        // Reject wildly inaccurate readings
        if (acc > 150) return;

        this.currentAccuracy = acc;

        // Compute GPS bearing and speed from consecutive raw fixes
        if (this.lastRawLat !== null) {
            const d = this.qDist(this.lastRawLat, this.lastRawLon, lat, lon);
            if (d > 1.2) {
                this.bearing = this.calcBearing(this.lastRawLat, this.lastRawLon, lat, lon);
                if (this.speed > 0.8 || d > 2.5) {
                    let bd = this.bearing - this.smoothHeading;
                    if (bd > 180) bd -= 360;
                    else if (bd < -180) bd += 360;
                    // Stronger GPS bearing blend at speed (0.65 instead of 0.55)
                    const bearingAlpha = this.speed > 5 ? 0.65 : 0.45;
                    this.smoothHeading += bearingAlpha * bd;
                    if (this.smoothHeading >= 360) this.smoothHeading -= 360;
                    else if (this.smoothHeading < 0) this.smoothHeading += 360;
                    this.heading = this.smoothHeading;
                    this.notifyListeners('heading', this.smoothHeading);
                }
            }
            if (d > 0.5 && d < 500) this.tripDistance += d;
        }
        this.lastRawLat = lat;
        this.lastRawLon = lon;

        // Kalman filter position
        this.currentLat = this.kUpdate(this.kalman.lat, lat, acc);
        this.currentLon = this.kUpdate(this.kalman.lon, lon, acc);

        // Initialize display position once
        if (this.displayLat === null) {
            this.displayLat = this.currentLat;
            this.displayLon = this.currentLon;
        }

        // Speed — prefer hardware GPS speed, compute fallback
        if (pos.coords.speed !== null && pos.coords.speed >= 0) {
            const rawSpd = pos.coords.speed;
            // Faster EMA (alpha=0.5) for quicker acceleration/deceleration response
            this.speed = this.speed === 0 ? rawSpd : this.speed + 0.5 * (rawSpd - this.speed);
        } else {
            const now = Date.now();
            if (this.lastSpeedLat !== null && now - this.lastSpeedTime > 300) {
                const dt = (now - this.lastSpeedTime) / 1000;
                const dist = this.qDist(this.lastSpeedLat, this.lastSpeedLon, lat, lon);
                if (dt > 0 && dist < 150) {
                    const computed = dist / dt;
                    this.speed = this.speed === 0 ? computed : this.speed + 0.5 * (computed - this.speed);
                }
            }
            this.lastSpeedLat = lat;
            this.lastSpeedLon = lon;
            this.lastSpeedTime = now;
        }

        if (pos.coords.altitude !== null) this.altitude = Math.round(pos.coords.altitude);

        // Trip stats
        const kmh = this.speed * 3.6;
        if (kmh > this.maxSpeed) this.maxSpeed = kmh;
        this.speedSamples.push(kmh);
        if (this.speedSamples.length > 500) this.speedSamples.shift();

        this.lastUpdateTime = performance.now();
        this.throttledNotify();
    },

    // ── Dead Reckoning — runs at rAF ──
    drLoop() {
        if (!this.active) return;
        this.deadReckon();
        requestAnimationFrame(this._drLoop);
    },

    deadReckon() {
        if (!this.initialized || this.speed < 0.15) {
            this.lastDRTime = performance.now();
            return;
        }
        const now = performance.now();
        let dt = (now - this.lastDRTime) / 1000;
        this.lastDRTime = now;

        if (dt <= 0 || dt > 0.5) return;

        const hr = this.smoothHeading * Math.PI / 180;
        const dist = this.speed * dt;
        const R = 6378137;
        const baseLat = this.displayLat || this.currentLat;

        const dLat = (dist * Math.cos(hr)) / R * (180 / Math.PI);
        const dLon = (dist * Math.sin(hr)) / (R * Math.cos(baseLat * Math.PI / 180)) * (180 / Math.PI);

        if (this.displayLat !== null) {
            this.displayLat += dLat;
            this.displayLon += dLon;

            // Slower correction towards Kalman GPS (5% per frame — prevents DR overshoot on sharp turns)
            if (this.currentLat !== null) {
                this.displayLat += (this.currentLat - this.displayLat) * 0.05;
                this.displayLon += (this.currentLon - this.displayLon) * 0.05;
            }
        }

        this.throttledNotify();
    },

    // ── Throttled notify at 30fps cap (navigation doesn't need 60fps) ──
    throttledNotify() {
        const now = performance.now();
        if (now - this.lastNotifyTime < 33) return; // 30fps cap
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

    // ── Road Quality via Accelerometer ──
    initAccelerometer() {
        if (!window.DeviceMotionEvent) return;
        let lastAccelTime = 0;
        window.addEventListener('devicemotion', (e) => {
            const now = Date.now();
            if (now - lastAccelTime < 120) return;
            lastAccelTime = now;

            let mag;
            if (e.acceleration && e.acceleration.x !== null) {
                mag = Math.sqrt(e.acceleration.x ** 2 + e.acceleration.y ** 2 + e.acceleration.z ** 2);
            } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null) {
                const ag = e.accelerationIncludingGravity;
                mag = Math.abs(Math.sqrt(ag.x ** 2 + ag.y ** 2 + ag.z ** 2) - 9.81);
            } else return;

            this.accelSamples.push(mag);
            if (this.accelSamples.length > 20) this.accelSamples.shift();

            if (this.accelSamples.length >= 15 && this.roughRoadCooldown <= 0) {
                const avg = this.accelSamples.reduce((a, b) => a + b, 0) / this.accelSamples.length;
                const rqEl = document.getElementById('road-quality');
                const rqText = document.getElementById('rq-text');
                if (avg > 3.5) {
                    if (rqEl) { rqEl.classList.remove('rq-hidden'); rqEl.classList.add('rq-visible'); }
                    if (rqText) rqText.innerText = '⚠️ Pothole / Bump!';
                    this.roughRoadCooldown = 50;
                    if (navigator.vibrate) navigator.vibrate(150);
                } else if (avg > 2.0) {
                    if (rqEl) { rqEl.classList.remove('rq-hidden'); rqEl.classList.add('rq-visible'); }
                    if (rqText) rqText.innerText = '⚡ Rough Road';
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
        const avgSpd = this.speedSamples.length > 0
            ? this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length : 0;
        return {
            distance: (this.tripDistance / 1000).toFixed(1),
            duration: this.fmtDur(dur),
            avgSpeed: Math.round(avgSpd),
            maxSpeed: Math.round(this.maxSpeed)
        };
    },

    fmtDur(s) {
        const m = Math.floor(s / 60), h = Math.floor(m / 60);
        return h > 0 ? `${h}:${(m % 60).toString().padStart(2, '0')}` : `${m}:${Math.round(s % 60).toString().padStart(2, '0')}`;
    },

    // ── Utilities ──
    calcBearing(a, b, c, d) {
        const p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dl = (d - b) * Math.PI / 180;
        return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
    },

    qDist(a, b, c, d) {
        const R = 6378137, dLat = (c - a) * Math.PI / 180, dLon = (d - b) * Math.PI / 180, co = Math.cos((a + c) / 2 * Math.PI / 180);
        return Math.sqrt((dLat * R) ** 2 + (dLon * co * R) ** 2);
    },

    handleError(e) { console.warn('GPS Error:', e.code, e.message); },
    onUpdate(cb) { this.listeners.push(cb); },
    notifyListeners(t, v) { for (let i = 0; i < this.listeners.length; i++) this.listeners[i](t, v); },

    destroy() {
        this.active = false;
        if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
        if (this._handleOrientation) window.removeEventListener('deviceorientation', this._handleOrientation);
        this.listeners = [];
        this.initialized = false;
        this.kalman.lat.init = false;
        this.kalman.lon.init = false;
        this.currentLat = null; this.currentLon = null;
        this.displayLat = null; this.displayLon = null;
        this.watchId = null;
        this.tripDistance = 0; this.maxSpeed = 0;
        this.speedSamples = []; this.accelSamples = [];
        this.headingHistory = [];
        this.lastRawLat = null; this.lastRawLon = null;
        this.speed = 0; this.smoothHeading = 0;
    }
};
