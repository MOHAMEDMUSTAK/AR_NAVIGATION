// route.js — Precision Route Engine v4
// Multi-mode routing, accurate voice navigation, real-time snapping, dynamic origin

window.RouteManager = {
    steps: [], pathCoordinates: [], totalDistance: 0, remainingDistance: 0, currentStepIndex: 0,
    mapInstance: null, fullMapInstance: null, routeLayer: null, fullRouteLayer: null,
    userMarker: null, fullUserMarker: null, turnMarkers: [], fullTurnMarkers: [],
    originLat: null, originLon: null, allRoutes: [], selectedRouteIndex: 0, etaSeconds: 0,
    audioEnabled: false, announced500m: false, announced200m: false, announced50m: false,
    recalculating: false, recalcCooldown: 0,
    destLat: null, destLon: null, destName: '', isFullMapOpen: false,
    currentRoadName: '--', speedLimitKmh: 0,
    travelMode: 'driving', // 'driving', 'walking', 'cycling'
    lastSnapIndex: 0, lastUIDraw: 0, lastMapPan: 0, lastCheckTime: 0,
    lastArBuildLat: null, lastArBuildLon: null,

    DOMFast: {
        cache: {},
        text(id, val) { if (this.cache[id] === val) return; this.cache[id] = val; const el = document.getElementById(id); if (el) el.innerText = val; },
        class(id, addC, rmC) { const k = id+'_c'; if (this.cache[k] === addC) return; this.cache[k] = addC; const el = document.getElementById(id); if (el) { if (rmC) el.classList.remove(rmC); el.classList.add(addC); } }
    },

    // ── OSRM profile from travel mode ──
    getOSRMProfile() {
        if (this.travelMode === 'walking') return 'foot';
        if (this.travelMode === 'cycling') return 'bicycle';
        return 'driving';
    },

    // ── FETCH ROUTE ──
    async fetchRoute(startLat, startLon, endLat, endLon, isReroute = false) {
        this.destLat = endLat; this.destLon = endLon;
        
        // CRITICAL FIX: Always update origin to current position
        // This prevents AR coordinate overflow when traveling far
        this.originLat = startLat;
        this.originLon = startLon;
        
        this.initMiniMap(startLat, startLon);

        const profile = this.getOSRMProfile();
        const url1 = `https://router.project-osrm.org/route/v1/${profile}/${startLon},${startLat};${endLon},${endLat}?steps=true&geometries=geojson&overview=full&annotations=distance,duration`;
        const url2 = `https://routing.openstreetmap.de/routed-${profile === 'foot' ? 'foot' : profile === 'bicycle' ? 'bike' : 'car'}/route/v1/${profile}/${startLon},${startLat};${endLon},${endLat}?steps=true&geometries=geojson&overview=full&annotations=distance,duration`;

        let data = null;

        // Sequential fallback instead of Promise.any to avoid bad partial results
        try {
            const controller1 = new AbortController();
            setTimeout(() => controller1.abort(), 5000);
            const res1 = await fetch(url1, { signal: controller1.signal });
            const json1 = await res1.json();
            if (json1.code === 'Ok' && json1.routes?.length) data = json1;
        } catch(e) {}

        if (!data) {
            try {
                const controller2 = new AbortController();
                setTimeout(() => controller2.abort(), 5000);
                const res2 = await fetch(url2, { signal: controller2.signal });
                const json2 = await res2.json();
                if (json2.code === 'Ok' && json2.routes?.length) data = json2;
            } catch(e) {}
        }

        if (!data) {
            throw new Error("Route could not be calculated. Check your connection.");
        }

        this.allRoutes = data.routes;
        if (data.routes.length > 1 && !isReroute) this.showRouteAlts(data.routes);
        this.selectRoute(0);

        // Fetch weather
        this.fetchWeather(endLat, endLon);
        return true;
    },

    selectRoute(i) {
        if (i >= this.allRoutes.length) return;
        this.selectedRouteIndex = i;
        const r = this.allRoutes[i];
        this.totalDistance = r.distance;
        this.remainingDistance = r.distance;
        this.pathCoordinates = r.geometry.coordinates.map(c => ({ lon: c[0], lat: c[1] }));
        
        // Pre-compute cumulative distance from each point to the end
        if (this.pathCoordinates.length > 0) {
            let d = 0;
            this.pathCoordinates[this.pathCoordinates.length - 1].cumulativeDist = 0;
            for (let j = this.pathCoordinates.length - 2; j >= 0; j--) {
                d += this.haversine(this.pathCoordinates[j].lat, this.pathCoordinates[j].lon, this.pathCoordinates[j+1].lat, this.pathCoordinates[j+1].lon);
                this.pathCoordinates[j].cumulativeDist = d;
            }
        }
        this.lastSnapIndex = 0;
        this.lastUIDraw = 0;

        if (r.legs?.length) {
            this.steps = r.legs[0].steps;
            this.currentStepIndex = 0;
            this.announced500m = this.announced200m = this.announced50m = false;
            if (this.steps[0]?.name) this.updateRoadName(this.steps[0].name);
        }

        this.etaSeconds = r.duration;
        this.updateETADisplay();
        this.drawRoute(r.geometry.coordinates);
        this.drawTurnMarkers();
        this.updateHUD();
        
        // Update destination name in top HUD
        this.DOMFast.text('dest-name-hud', this.destName || 'Destination');
        
        // Set speed limit based on travel mode
        let speedLimit = 0;
        if (this.travelMode === 'driving') speedLimit = 60;
        else if (this.travelMode === 'cycling') speedLimit = 20;
        else if (this.travelMode === 'walking') speedLimit = 5;
        
        const slc = document.getElementById('speed-limit-circle');
        if (slc) {
            if (speedLimit > 0) {
                slc.classList.remove('speed-limit-hidden');
                this.DOMFast.text('speed-limit-val', speedLimit);
            } else {
                slc.classList.add('speed-limit-hidden');
            }
        }

        if (window.ARScene?.buildPath) window.ARScene.buildPath();
        const p = document.getElementById('route-alternatives-panel');
        if (p) p.classList.add('alt-hidden');
    },

    showRouteAlts(routes) {
        const p = document.getElementById('route-alternatives-panel');
        if (!p) return; p.innerHTML = ''; p.classList.remove('alt-hidden');
        routes.forEach((r, i) => {
            const c = document.createElement('div');
            c.className = `route-card ${i===0 ? 'route-card-selected' : ''}`;
            c.innerHTML = `<div class="route-card-label">${i===0 ? 'Fastest' : i===1 ? 'Alternative' : `Route ${i+1}`}</div><div class="route-card-time">${Math.round(r.duration/60)} min</div><div class="route-card-dist">${(r.distance/1000).toFixed(1)} km</div>`;
            c.addEventListener('click', () => { p.querySelectorAll('.route-card').forEach(x => x.classList.remove('route-card-selected')); c.classList.add('route-card-selected'); this.selectRoute(i); });
            p.appendChild(c);
        });
        setTimeout(() => p.classList.add('alt-hidden'), 12000);
    },

    // ── WEATHER ──
    async fetchWeather(lat, lon) {
        try {
            const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
            const data = await res.json();
            if (data.current_weather) {
                const w = data.current_weather;
                const temp = Math.round(w.temperature);
                const code = w.weathercode;
                let icon = '☀️', text = 'Clear';

                if (code >= 71) { icon = '🌨️'; text = 'Snow'; }
                else if (code >= 61) { icon = '🌧️'; text = 'Rain'; }
                else if (code >= 51) { icon = '🌦️'; text = 'Drizzle'; }
                else if (code >= 45) { icon = '🌫️'; text = 'Foggy'; }
                else if (code >= 3) { icon = '☁️'; text = 'Cloudy'; }
                else if (code >= 1) { icon = '⛅'; text = 'Partly Cloudy'; }

                const banner = document.getElementById('weather-banner');
                document.getElementById('weather-icon').innerText = icon;
                document.getElementById('weather-text').innerText = text;
                document.getElementById('weather-temp').innerText = `${temp}°C`;
                if (banner) { banner.classList.remove('weather-hidden'); banner.classList.add('weather-visible'); }

                if (code >= 61 && this.audioEnabled) {
                    setTimeout(() => this.speak(`Weather warning: ${text} conditions. Drive carefully.`), 3000);
                }
            }
        } catch(e) { console.warn("Weather fail:", e); }
    },

    // ── ROAD NAME ──
    updateRoadName(name) {
        this.currentRoadName = name || '--';
        this.DOMFast.text('road-name', this.currentRoadName);
    },

    // ── Ultra-Precision Spatial Anchoring (Eliminates Spherical Projection Drift) ──
    latLonToAnchor(lat, lon, anchorLat, anchorLon) {
        if (!anchorLat || !anchorLon) return { x: 0, z: 0 };
        const R = 6378137;
        const dLat = (lat - anchorLat) * Math.PI / 180;
        const dLon = (lon - anchorLon) * Math.PI / 180;
        const cosLat = Math.cos(anchorLat * Math.PI / 180);
        return { x: R * dLon * cosLat, z: -(R * dLat) };
    },

    // ── Convenience: latLonToLocal uses the current route origin as anchor ──
    latLonToLocal(lat, lon) {
        return this.latLonToAnchor(lat, lon, this.originLat, this.originLon);
    },


    // ── MINIMAP ──
    initMiniMap(lat, lon) {
        const w = document.getElementById('minimap-wrapper');
        if (w) { w.classList.remove('nav-hidden'); w.classList.add('nav-visible'); }
        if (this.mapInstance) return;

        this.mapInstance = L.map('minimap', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false }).setView([lat, lon], 16);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(this.mapInstance);

        const ic = L.divIcon({ className: 'custom-div-icon', html: '<div class="user-marker-dot"><div class="user-marker-pulse"></div></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
        this.userMarker = L.marker([lat, lon], { icon: ic }).addTo(this.mapInstance);

        document.getElementById('minimap-wrapper').addEventListener('click', e => { e.stopPropagation(); this.toggleFullMap(); });

        window.GPS.onUpdate((t, d) => {
            if (t === 'position') {
                const now = Date.now();

                // Heading-Up Minimap
                const mapEl = document.getElementById('minimap');
                if (mapEl && window.GPS.smoothHeading != null) {
                    mapEl.style.transform = `rotate(${-window.GPS.smoothHeading}deg)`;
                    mapEl.style.transformOrigin = 'center center';
                    if (this.userMarker._icon) this.userMarker._icon.style.transform = `rotate(${window.GPS.smoothHeading}deg)`;
                }

                // Smooth marker movement
                if (this.userMarker._icon) {
                    this.userMarker._icon.style.transition = 'transform 0.1s linear, top 0.1s linear, left 0.1s linear';
                }
                this.userMarker.setLatLng([d.lat, d.lon]);

                // Pan map every 400ms
                if (!this.lastMapPan || now - this.lastMapPan >= 400) {
                    this.mapInstance.panTo([d.lat, d.lon], { animate: true, duration: 0.4, easeLinearity: 1 });
                    this.lastMapPan = now;
                }

                if (this.fullUserMarker) {
                    if (this.fullUserMarker._icon) this.fullUserMarker._icon.style.transition = 'transform 0.1s linear';
                    this.fullUserMarker.setLatLng([d.lat, d.lon]);
                }

                // Check progress at 5 FPS for responsive navigation
                if (!this.lastCheckTime || now - this.lastCheckTime >= 200) {
                    this.lastCheckTime = now;
                    this.checkProgress(d.lat, d.lon);
                }
            }
        });
    },

    // ── FULLSCREEN MAP ──
    toggleFullMap() {
        const o = document.getElementById('fullscreen-map-overlay');
        if (!o) return;
        if (this.isFullMapOpen) {
            o.classList.remove('fullmap-open'); o.classList.add('fullmap-closed'); this.isFullMapOpen = false;
        } else {
            o.classList.remove('fullmap-closed'); o.classList.add('fullmap-open'); this.isFullMapOpen = true;
            if (!this.fullMapInstance) this.initFullMap();
            else { this.fullMapInstance.invalidateSize(); if (window.GPS.currentLat) this.fullMapInstance.setView([window.GPS.currentLat, window.GPS.currentLon], 15); }
        }
    },

    initFullMap() {
        this.fullMapInstance = L.map('fullscreen-map', { zoomControl: true, attributionControl: false, dragging: true, scrollWheelZoom: true, touchZoom: true }).setView([window.GPS.currentLat || 0, window.GPS.currentLon || 0], 15);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(this.fullMapInstance);

        const ic = L.divIcon({ className: 'custom-div-icon', html: '<div class="user-marker-dot"><div class="user-marker-pulse"></div></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
        this.fullUserMarker = L.marker([window.GPS.currentLat || 0, window.GPS.currentLon || 0], { icon: ic }).addTo(this.fullMapInstance);

        if (this.pathCoordinates.length) {
            const ll = this.pathCoordinates.map(c => [c.lat, c.lon]);
            this.fullRouteLayer = L.polyline(ll, { color: '#b000ff', weight: 5, opacity: 0.9 }).addTo(this.fullMapInstance);
            this.fullMapInstance.fitBounds(this.fullRouteLayer.getBounds(), { padding: [40, 40] });
        }

        this.drawFullTurnMarkers();

        if (this.destLat) {
            const di = L.divIcon({ className: 'custom-div-icon', html: '<div class="dest-marker-dot">📍</div>', iconSize: [28, 28], iconAnchor: [14, 28] });
            L.marker([this.destLat, this.destLon], { icon: di }).addTo(this.fullMapInstance).bindPopup(this.destName || 'Destination');
        }

        document.getElementById('close-fullmap-btn').addEventListener('click', e => { e.stopPropagation(); this.toggleFullMap(); });
    },

    drawRoute(coords) {
        if (this.routeLayer) this.mapInstance.removeLayer(this.routeLayer);
        const ll = coords.map(c => [c[1], c[0]]);
        this.routeLayer = L.polyline(ll, { color: '#b000ff', weight: 4, opacity: 0.8 }).addTo(this.mapInstance);
        this.mapInstance.fitBounds(this.routeLayer.getBounds(), { padding: [10, 10] });
        if (this.fullMapInstance) {
            if (this.fullRouteLayer) this.fullMapInstance.removeLayer(this.fullRouteLayer);
            this.fullRouteLayer = L.polyline(ll, { color: '#b000ff', weight: 5, opacity: 0.9 }).addTo(this.fullMapInstance);
        }
    },

    drawTurnMarkers() {
        this.turnMarkers.forEach(m => this.mapInstance.removeLayer(m)); this.turnMarkers = [];
        this.steps.forEach((s, i) => {
            if (i === 0) return;
            const loc = s.maneuver.location, mod = s.maneuver.modifier || 'straight';
            let a = '⬆'; if (mod.includes('left')) a = '⬅'; else if (mod.includes('right')) a = '➡'; else if (mod.includes('uturn')) a = '↩';
            const ic = L.divIcon({ className: 'custom-div-icon', html: `<div class="turn-marker-dot">${a}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
            this.turnMarkers.push(L.marker([loc[1], loc[0]], { icon: ic }).addTo(this.mapInstance));
        });
    },

    drawFullTurnMarkers() {
        if (!this.fullMapInstance) return;
        this.fullTurnMarkers.forEach(m => this.fullMapInstance.removeLayer(m)); this.fullTurnMarkers = [];
        this.steps.forEach((s, i) => {
            if (i === 0) return;
            const loc = s.maneuver.location, mod = s.maneuver.modifier || 'straight', instr = s.maneuver.instruction || '';
            let a = '⬆'; if (mod.includes('left')) a = '⬅'; else if (mod.includes('right')) a = '➡'; else if (mod.includes('uturn')) a = '↩';
            const ic = L.divIcon({ className: 'custom-div-icon', html: `<div class="turn-marker-dot-lg">${a}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
            this.fullTurnMarkers.push(L.marker([loc[1], loc[0]], { icon: ic }).addTo(this.fullMapInstance).bindPopup(instr));
        });
    },

    // ── SNAPPING (Vector Projection) ──
    projectPoint(pLat, pLon, p1, p2) {
        const R = 6378137;
        const dLat2 = (p2.lat - p1.lat) * (Math.PI / 180);
        const dLon2 = (p2.lon - p1.lon) * (Math.PI / 180);
        const y2 = dLat2 * R, x2 = dLon2 * R * Math.cos(p1.lat * (Math.PI / 180));
        const dLatP = (pLat - p1.lat) * (Math.PI / 180);
        const dLonP = (pLon - p1.lon) * (Math.PI / 180);
        const yP = dLatP * R, xP = dLonP * R * Math.cos(p1.lat * (Math.PI / 180));
        const segLenSq = x2 * x2 + y2 * y2;
        if (segLenSq === 0) return { lat: p1.lat, lon: p1.lon, t: 0 };
        const t = Math.max(0, Math.min(1, (xP * x2 + yP * y2) / segLenSq));
        return { lat: p1.lat + t * (p2.lat - p1.lat), lon: p1.lon + t * (p2.lon - p1.lon), t };
    },

    snapToRoute(lat, lon) {
        // PREDICTIVE GPS PHYSICS: Propagate current coordinate forward along velocity vector 
        // to completely eliminate the physical 0.8s hardware mapping lag.
        const spd = window.GPS.speed || 0;
        const lookAheadMeters = spd * 0.8; 
        
        let pLat = lat, pLon = lon;
        if (lookAheadMeters > 0) {
            const R = 6378137;
            const hr = (window.GPS.smoothHeading || 0) * Math.PI / 180;
            pLat += (lookAheadMeters * Math.cos(hr)) / R * (180 / Math.PI);
            pLon += (lookAheadMeters * Math.sin(hr)) / (R * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);
        }

        let minCost = Infinity, bestIdx = this.lastSnapIndex || 0, bestSnap = { lat: pLat, lon: pLon, t: 0 };
        const h = window.GPS.smoothHeading || 0;
        
        // Search window biased towards the forward direction
        const start = Math.max(0, bestIdx - 10); // Tighten backward search
        const end = Math.min(this.pathCoordinates.length - 1, bestIdx + 150); // Expand forward search


        for (let i = start; i < end; i++) {
            const p1 = this.pathCoordinates[i], p2 = this.pathCoordinates[i + 1];
            if (!p2) continue;
            const proj = this.projectPoint(pLat, pLon, p1, p2);
            const dist = this.haversine(pLat, pLon, proj.lat, proj.lon);
            const b = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);

            // Dot product for direction agreement
            const bx = Math.sin(b * Math.PI / 180), by = Math.cos(b * Math.PI / 180);
            const hx = Math.sin(h * Math.PI / 180), hy = Math.cos(h * Math.PI / 180);
            const dotProduct = bx * hx + by * hy;

            const dotPenalty = dotProduct < 0 ? 50 : Math.max(1, 1.5 - dotProduct);
            const cost = dist * dotPenalty;

            if (cost < minCost) { minCost = cost; bestIdx = i; bestSnap = proj; }
        }

        // Global fallback if badly lost
        if (minCost > 1500) {
            for (let i = 0; i < this.pathCoordinates.length - 1; i++) {
                const p1 = this.pathCoordinates[i], p2 = this.pathCoordinates[i + 1];
                const proj = this.projectPoint(pLat, pLon, p1, p2);
                const dist = this.haversine(pLat, pLon, proj.lat, proj.lon);
                const b = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);
                const bx = Math.sin(b * Math.PI / 180), by = Math.cos(b * Math.PI / 180);
                const hx = Math.sin(h * Math.PI / 180), hy = Math.cos(h * Math.PI / 180);
                const dotProduct = bx * hx + by * hy;
                const cost = dist * (dotProduct < 0 ? 10 : Math.max(1, 1.2 - dotProduct));
                if (cost < minCost) { minCost = cost; bestIdx = i; bestSnap = proj; }
            }
        }

        this.lastSnapIndex = bestIdx;
        return { index: bestIdx, distance: this.haversine(lat, lon, bestSnap.lat, bestSnap.lon), snappedLat: bestSnap.lat, snappedLon: bestSnap.lon, t: bestSnap.t };
    },

    calcRemaining(snap) {
        if (!this.pathCoordinates[snap.index]) return 0;
        let d = this.pathCoordinates[snap.index].cumulativeDist || 0;
        const p1 = this.pathCoordinates[snap.index], p2 = this.pathCoordinates[snap.index + 1];
        if (p2) {
            const segDist = this.haversine(p1.lat, p1.lon, p2.lat, p2.lon);
            d -= (segDist * snap.t);
        }
        return Math.max(0, d);
    },

    // ════════════════════════════════════════════════════════
    // VOICE INSTRUCTION GENERATOR — Clear, accurate directions
    // ════════════════════════════════════════════════════════
    buildVoiceInstruction(step) {
        const mod = step.maneuver.modifier || 'straight';
        const mType = step.maneuver.type || '';
        const roadName = step.name || '';
        const rdText = roadName ? ` onto ${roadName}` : '';

        // Build clear, specific turn-by-turn instructions
        switch(mType) {
            case 'turn':
                if (mod.includes('sharp left')) return `Make a sharp left turn${rdText}`;
                if (mod.includes('slight left')) return `Turn slightly left${rdText}`;
                if (mod.includes('left')) return `Turn left${rdText}`;
                if (mod.includes('sharp right')) return `Make a sharp right turn${rdText}`;
                if (mod.includes('slight right')) return `Turn slightly right${rdText}`;
                if (mod.includes('right')) return `Turn right${rdText}`;
                if (mod.includes('uturn')) return `Make a U-turn${rdText}`;
                return `Continue straight${rdText}`;
                
            case 'new name':
            case 'continue':
                return `Continue${rdText}`;
                
            case 'depart':
                if (mod.includes('left')) return `Head left${rdText}`;
                if (mod.includes('right')) return `Head right${rdText}`;
                return `Start heading${rdText}`;
                
            case 'arrive':
                if (mod.includes('left')) return `Your destination is on the left`;
                if (mod.includes('right')) return `Your destination is on the right`;
                return `You have arrived at your destination`;
                
            case 'roundabout':
            case 'rotary':
                const exit = step.maneuver.exit || '';
                const exitText = exit ? this.ordinal(exit) + ' exit' : 'the exit';
                return `At the roundabout, take ${exitText}${rdText}`;
                
            case 'merge':
                if (mod.includes('left')) return `Merge left${rdText}`;
                if (mod.includes('right')) return `Merge right${rdText}`;
                return `Merge${rdText}`;
                
            case 'on ramp':
            case 'ramp':
                return `Take the ramp${rdText}`;
                
            case 'off ramp':
                return `Take the exit${rdText}`;
                
            case 'fork':
                if (mod.includes('left')) return `Keep left at the fork${rdText}`;
                if (mod.includes('right')) return `Keep right at the fork${rdText}`;
                return `Continue at the fork${rdText}`;
                
            case 'end of road':
                if (mod.includes('left')) return `At the end of the road, turn left${rdText}`;
                if (mod.includes('right')) return `At the end of the road, turn right${rdText}`;
                return `At the end of the road, continue${rdText}`;
                
            case 'notification':
                return step.maneuver.instruction || `Continue${rdText}`;
                
            default:
                // Fallback — use modifier for direction
                if (mod.includes('sharp left')) return `Sharp left${rdText}`;
                if (mod.includes('slight left')) return `Slight left${rdText}`;
                if (mod.includes('left')) return `Turn left${rdText}`;
                if (mod.includes('sharp right')) return `Sharp right${rdText}`;
                if (mod.includes('slight right')) return `Slight right${rdText}`;
                if (mod.includes('right')) return `Turn right${rdText}`;
                if (mod.includes('uturn')) return `Make a U-turn${rdText}`;
                return `Continue straight${rdText}`;
        }
    },

    ordinal(n) {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    },

    // Get a short direction word for HUD display
    getDirectionWord(mod) {
        if (!mod) return 'Straight';
        if (mod.includes('sharp left')) return 'Sharp Left';
        if (mod.includes('slight left')) return 'Slight Left';
        if (mod.includes('left')) return 'Left';
        if (mod.includes('sharp right')) return 'Sharp Right';
        if (mod.includes('slight right')) return 'Slight Right';
        if (mod.includes('right')) return 'Right';
        if (mod.includes('uturn')) return 'U-Turn';
        return 'Straight';
    },

    // ── MAIN NAV LOOP ──
    checkProgress(lat, lon) {
        if (this.recalcCooldown > 0) this.recalcCooldown--;
        if (this.pathCoordinates.length < 2) return;
        
        const snap = this.snapToRoute(lat, lon);
        this.remainingDistance = this.calcRemaining(snap);

        const sLatVirtual = snap.snappedLat || lat;
        const sLonVirtual = snap.snappedLon || lon;

        // Arrival detection
        if (this.remainingDistance < 15) {
            this.DOMFast.text('turn-dist', "0m");
            this.DOMFast.text('road-name', "Arrived!");
            this.setArrow('turn-arrow', 'arrow-3d', 'straight');
            if (this.audioEnabled) this.speak("You have arrived at your destination.");
            return;
        }

        // ═══ STABILIZED REROUTE DETECTION ═══
        this.offRouteCounter = this.offRouteCounter || 0;
        
        // 1. Distance-based: Relaxed to absorb phone GPS inaccuracy around trees/buildings (35m for driving, 20m for walking)
        const rerouteThreshold = this.travelMode === 'walking' ? 20 : 35;
        let spdMs = window.GPS.speed || 0;
        
        // 2. Wrong-way detection: Require significant speed (>3 m/s) to trust compass heading and avoid jitter at red lights
        let isWrongWay = false;
        if (snap.index < this.pathCoordinates.length - 1 && spdMs > 3.0) {
            const p1 = this.pathCoordinates[snap.index];
            const p2 = this.pathCoordinates[snap.index + 1];
            const routeBearing = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);
            let headingDiff = Math.abs(window.GPS.smoothHeading - routeBearing);
            if (headingDiff > 180) headingDiff = 360 - headingDiff;
            isWrongWay = headingDiff > 120;
        }
        
        const shouldReroute = (snap.distance > rerouteThreshold) || (isWrongWay && snap.distance > 15);
        
        if (shouldReroute) {
            this.offRouteCounter++;
        } else {
            this.offRouteCounter = 0; // Immediate reset if back on expected track
        }
        
        // Must be continuously off-route for at least 10 frames (~2.0 seconds) to trigger global logic breakdown
        if (this.offRouteCounter > 10 && !this.recalculating && this.recalcCooldown <= 0) {
            this.recalculating = true; 
            this.recalcCooldown = 15; // Fast reroute response
            this.offRouteCounter = 0;
            if (isWrongWay && spdMs > 3) {
                this.speak("Wrong way. Recalculating route.");
            } else if (snap.distance > rerouteThreshold) {
                this.speak("Recalculating.");
            }
            this.DOMFast.text('road-name', "Rerouting...");
            this.fetchRoute(lat, lon, this.destLat, this.destLon, true)
                .then(() => { this.recalculating = false; })
                .catch(() => { this.recalculating = false; });
            return;
        }

        
        // Warn if slightly off route (between 10m and threshold)
        if (snap.distance > 10 && snap.distance <= rerouteThreshold && !this.offRouteWarned) {
            this.offRouteWarned = true;
            if (this.audioEnabled) this.speak("Return to the route.");
        }
        if (snap.distance <= 8) this.offRouteWarned = false;

        if (this.currentStepIndex >= this.steps.length) return;
        
        const step = this.steps[this.currentStepIndex];
        const sLat = step.maneuver.location[1], sLon = step.maneuver.location[0];
        const distToTurn = this.haversine(sLatVirtual, sLonVirtual, sLat, sLon);
        const mod = step.maneuver.modifier || 'straight';

        // Throttle DOM updates to ~3 FPS
        const now = Date.now();
        if (now - (this.lastUIDraw || 0) >= 300) {
            this.lastUIDraw = now;

            if (step.name) this.updateRoadName(step.name);
            this.DOMFast.text('turn-dist', this.fmt(distToTurn));
            this.setArrow('turn-arrow', 'arrow-3d', mod);

            // Speed warning
            const kmh = window.GPS.speed * 3.6;
            const speedLimit = distToTurn > 500 ? 120 : 80;
            if (kmh > speedLimit) {
                this.DOMFast.class('speed-warning', 'speed-warn-visible', 'speed-warn-hidden');
                if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
            } else {
                this.DOMFast.class('speed-warning', 'speed-warn-hidden', 'speed-warn-visible');
            }

            if (distToTurn < 150) {
                this.setArrow('hud-arrow-3d', 'mega-arrow', mod);
            }

            this.updateLanes(step, distToTurn);
            this.updateETAFromSpeed();
        }

        // ════════════════════════════════════════════════════
        // VOICE GUIDANCE — Accurate, clear turn-by-turn
        // ════════════════════════════════════════════════════
        if (this.audioEnabled) {
            const voiceInstr = this.buildVoiceInstruction(step);
            
            // Approaching turn announcements
            if (distToTurn < 500 && distToTurn > 300 && !this.announced500m) {
                this.announced500m = true;
                this.speak(`In ${Math.round(distToTurn)} meters, ${voiceInstr}`);
            }
            if (distToTurn < 200 && distToTurn > 100 && !this.announced200m) {
                this.announced200m = true;
                this.speak(`In ${Math.round(distToTurn)} meters, ${voiceInstr}`);
            }
            if (distToTurn < 50 && distToTurn > 15 && !this.announced50m) {
                this.announced50m = true;
                this.speak(`Now, ${voiceInstr}`);
            }
            
            // For walking mode, also announce at closer range
            if (this.travelMode === 'walking') {
                if (distToTurn < 30 && distToTurn > 10 && !this.announcedWalk30) {
                    this.announcedWalk30 = true;
                    this.speak(voiceInstr);
                }
            }
        }

        // Step advance with velocity-scaled turn anticipation
        spdMs = window.GPS.speed || 0;
        const baseRadius = this.travelMode === 'walking' ? 5 : 8;
        const radius = Math.max(baseRadius, Math.min((window.GPS.currentAccuracy || 10), 20)) + (spdMs * 1.5);
        
        if (distToTurn < radius) {
            this.currentStepIndex++;
            this.announced500m = this.announced200m = this.announced50m = false;
            this.announcedWalk30 = false;
            
            if (this.currentStepIndex < this.steps.length) {
                const nextStep = this.steps[this.currentStepIndex];
                const nm = nextStep.maneuver.modifier || 'straight';
                this.setArrow('turn-arrow', 'arrow-3d', nm);

                // Rebuild AR path
                if (window.ARScene?.buildPath) {
                    window.ARScene.buildPath();
                    this.lastArBuildLat = lat; this.lastArBuildLon = lon;
                }

                // Announce the NEXT turn
                if (this.audioEnabled) {
                    const nLat = nextStep.maneuver.location[1], nLon = nextStep.maneuver.location[0];
                    const nDist = this.haversine(lat, lon, nLat, nLon);
                    const nextVoice = this.buildVoiceInstruction(nextStep);
                    
                    if (nDist > 30) {
                        this.speak(`Next, in ${Math.round(nDist)} meters, ${nextVoice}`);
                    } else {
                        this.speak(nextVoice);
                    }
                }
            }
        }

        // Dynamically rebuild AR arrows every 15m traveled
        if (!this.lastArBuildLat) {
            this.lastArBuildLat = lat; this.lastArBuildLon = lon;
        } else {
            const distSinceArBuild = this.haversine(lat, lon, this.lastArBuildLat, this.lastArBuildLon);
            // Increased to 60m to drastically reduce stuttering caused by geometric rebuilds
            if (distSinceArBuild > 60 && window.ARScene?.buildPath) {
                window.ARScene.buildPath();
                this.lastArBuildLat = lat;
                this.lastArBuildLon = lon;
            }
        }
    },

    // ── ARROWS ──
    setArrow(id, base, mod) {
        if (id === 'turn-arrow' || id === 'hud-arrow-3d') {
            const els = [
                { el: document.getElementById('turn-arrow-2d'), baseClass: 'hud-arrow-icon' },
                { el: document.getElementById('badge-arrow'), baseClass: 'mega-arrow' }
            ];

            let deg = 0;
            if (mod === 'sharp left') deg = -135;
            else if (mod === 'left') deg = -90;
            else if (mod === 'slight left') deg = -45;
            else if (mod === 'sharp right') deg = 135;
            else if (mod === 'right') deg = 90;
            else if (mod === 'slight right') deg = 45;

            els.forEach(item => {
                if (!item.el) return;
                if (mod.includes('uturn')) {
                    item.el.className = item.baseClass + ' arrow-uturn';
                    item.el.style.rotate = '0deg';
                } else {
                    item.el.className = item.baseClass + ' arrow-straight';
                    item.el.style.rotate = `${deg}deg`;
                    item.el.style.transition = 'rotate 0.35s cubic-bezier(0.4, 0.0, 0.2, 1)';
                }
            });
            return;
        }

        const el = document.getElementById(id); if (!el) return;
        let deg = 0;
        if (mod === 'sharp left') deg = -135;
        else if (mod === 'left') deg = -90;
        else if (mod === 'slight left') deg = -45;
        else if (mod === 'sharp right') deg = 135;
        else if (mod === 'right') deg = 90;
        else if (mod === 'slight right') deg = 45;

        if (mod.includes('uturn')) {
            el.className = base + ' arrow-uturn';
            el.style.rotate = '0deg';
        } else {
            el.className = base + ' arrow-straight';
            el.style.rotate = `${deg}deg`;
            el.style.transition = 'rotate 0.35s cubic-bezier(0.4, 0.0, 0.2, 1)';
        }
    },

    // ── LANES ──
    updateLanes(step, dist) {
        const c = document.getElementById('lane-guidance'); if (!c) return;
        if (dist > 300 || !step.intersections?.length) { c.classList.add('lane-hidden'); return; }
        const inter = step.intersections[step.intersections.length - 1];
        if (!inter.lanes?.length) { c.classList.add('lane-hidden'); return; }
        c.classList.remove('lane-hidden'); c.innerHTML = '';
        inter.lanes.forEach(l => {
            const d = document.createElement('div');
            d.className = `lane-arrow ${l.valid ? 'lane-active' : 'lane-inactive'}`;
            let a = '↑'; 
            if (l.indications) { 
                if (l.indications.includes('left')) a = '←'; 
                else if (l.indications.includes('right')) a = '→'; 
                else if (l.indications.includes('slight left')) a = '↖'; 
                else if (l.indications.includes('slight right')) a = '↗'; 
            }
            d.innerText = a; c.appendChild(d);
        });
    },

    // ── ETA ──
    updateETAFromSpeed() {
        const s = window.GPS.speed || 0;
        if (s > 0.3) {
            this.etaSeconds = this.remainingDistance / s;
        } else if (this.travelMode === 'walking') {
            // Walking average ~5 km/h = 1.39 m/s
            this.etaSeconds = this.remainingDistance / 1.39;
        } else if (this.travelMode === 'cycling') {
            // Cycling average ~15 km/h = 4.17 m/s 
            this.etaSeconds = this.remainingDistance / 4.17;
        }
        this.updateETADisplay();
    },

    updateETADisplay() {
        const m = Math.round(this.etaSeconds / 60);
        const a = new Date(Date.now() + this.etaSeconds * 1000);
        const h = a.getHours(), mi = a.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        this.DOMFast.text('bottom-time', `${h % 12 || 12}:${mi.toString().padStart(2, '0')} ${ampm}`);

        let durStr = '';
        if (m < 60) durStr = `${m} min`;
        else durStr = `${Math.floor(m / 60)}h ${m % 60}m`;
        this.DOMFast.text('remaining-time', durStr);
        
        // Update enhanced HUD elements
        this.DOMFast.text('remaining-eta', durStr);
        this.DOMFast.text('total-dist-val', this.fmt(this.remainingDistance));
    },

    fmt(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + 'm'; },
    updateHUD() { this.DOMFast.text('total-dist-val', this.fmt(this.totalDistance)); },

    haversine(a, b, c, d) {
        const R = 6371e3, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = (c - a) * Math.PI / 180, dl = (d - b) * Math.PI / 180;
        const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    },

    speak(t) {
        if (!this.audioEnabled || !window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(t);
        u.rate = 1.0;
        u.pitch = 1.0;
        u.volume = 1.0;
        u.lang = 'en-US';
        window.speechSynthesis.speak(u);
    },

    destroy() {
        this.steps = []; this.pathCoordinates = []; this.allRoutes = []; 
        this.currentStepIndex = 0; this.isFullMapOpen = false;
        this.DOMFast.cache = {};
        try { if (this.routeLayer && this.mapInstance) this.mapInstance.removeLayer(this.routeLayer); } catch(e) {}
        try { if (this.fullRouteLayer && this.fullMapInstance) this.fullMapInstance.removeLayer(this.fullRouteLayer); } catch(e) {}
        this.turnMarkers.forEach(m => { try { this.mapInstance.removeLayer(m); } catch(e) {} });
        this.fullTurnMarkers.forEach(m => { try { this.fullMapInstance.removeLayer(m); } catch(e) {} });
        this.routeLayer = null; this.fullRouteLayer = null; this.turnMarkers = []; this.fullTurnMarkers = [];
        this.lastArBuildLat = null; this.lastArBuildLon = null;
    }
};
