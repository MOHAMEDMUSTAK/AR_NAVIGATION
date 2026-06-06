// route.js — AstraNav Route Engine v5
// FIXES: Parallel OSRM fetch, Arrow ID fix, Time-based off-route, Snap improvements

window.RouteManager = {
    steps: [], pathCoordinates: [], totalDistance: 0, remainingDistance: 0, currentStepIndex: 0,
    mapInstance: null, fullMapInstance: null, routeLayer: null, fullRouteLayer: null,
    userMarker: null, fullUserMarker: null, turnMarkers: [], fullTurnMarkers: [],
    originLat: null, originLon: null, allRoutes: [], selectedRouteIndex: 0, etaSeconds: 0,
    audioEnabled: false,
    announced500m: false, announced200m: false, announced100m: false, announced50m: false,
    recalculating: false,
    destLat: null, destLon: null, destName: '',
    currentRoadName: '--', speedLimitKmh: 0,
    travelMode: 'driving',
    lastSnapIndex: 0, lastUIDraw: 0, lastMapPan: 0, lastCheckTime: 0,
    lastArBuildLat: null, lastArBuildLon: null,

    // Time-based off-route (more reliable than frame counting)
    offRouteStartTime: null,
    offRouteWarned: false,

    // DOM caching layer to minimize layout thrashing
    DOMFast: {
        cache: {},
        text(id, val) {
            if (this.cache[id] === val) return;
            this.cache[id] = val;
            const el = document.getElementById(id);
            if (el) el.innerText = val;
        },
        class(id, addC, rmC) {
            const k = id + '_c';
            if (this.cache[k] === addC) return;
            this.cache[k] = addC;
            const el = document.getElementById(id);
            if (el) { if (rmC) el.classList.remove(rmC); el.classList.add(addC); }
        }
    },

    getOSRMProfile() {
        if (this.travelMode === 'walking') return 'foot';
        if (this.travelMode === 'cycling') return 'bicycle';
        return 'driving';
    },

    // ═══════════════════════════════════════════════════════
    // FETCH ROUTE — Parallel providers, fastest valid result
    // ═══════════════════════════════════════════════════════
    async fetchRoute(startLat, startLon, endLat, endLon, isReroute = false) {
        this.destLat = endLat;
        this.destLon = endLon;
        this.originLat = startLat;
        this.originLon = startLon;

        this.initMiniMap(startLat, startLon);

        const profile = this.getOSRMProfile();
        const osrmProfile2 = profile === 'foot' ? 'foot' : profile === 'bicycle' ? 'bike' : 'car';

        const params = `steps=true&geometries=geojson&overview=full&annotations=distance,duration`;
        const coordStr = `${startLon},${startLat};${endLon},${endLat}`;

        const urls = [
            `https://router.project-osrm.org/route/v1/${profile}/${coordStr}?${params}`,
            `https://routing.openstreetmap.de/routed-${osrmProfile2}/route/v1/${profile}/${coordStr}?${params}`
        ];

        // Run both requests in PARALLEL — use first valid response
        const fetchWithTimeout = (url, ms) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), ms);
            return fetch(url, { signal: ctrl.signal })
                .then(r => r.json())
                .then(j => { clearTimeout(timer); return j; })
                .catch(() => null);
        };

        let data = null;
        try {
            const results = await Promise.all(urls.map(u => fetchWithTimeout(u, 4000)));
            for (const j of results) {
                if (j?.code === 'Ok' && j?.routes?.length) { data = j; break; }
            }
        } catch (e) {}

        if (!data) throw new Error('Route could not be calculated. Check your connection.');

        this.allRoutes = data.routes;
        if (data.routes.length > 1 && !isReroute) this.showRouteAlts(data.routes);
        this.selectRoute(0);
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

        // Pre-compute cumulative distance from each point to end (for fast remaining calc)
        if (this.pathCoordinates.length > 0) {
            let d = 0;
            this.pathCoordinates[this.pathCoordinates.length - 1].cumulativeDist = 0;
            for (let j = this.pathCoordinates.length - 2; j >= 0; j--) {
                d += this.haversine(
                    this.pathCoordinates[j].lat, this.pathCoordinates[j].lon,
                    this.pathCoordinates[j + 1].lat, this.pathCoordinates[j + 1].lon
                );
                this.pathCoordinates[j].cumulativeDist = d;
            }
        }

        this.lastSnapIndex = 0;
        this.lastUIDraw = 0;
        this.offRouteStartTime = null;
        this.offRouteWarned = false;

        if (r.legs?.length) {
            this.steps = r.legs[0].steps;
            this.currentStepIndex = 0;
            this.announced500m = this.announced200m = this.announced100m = this.announced50m = false;
            if (this.steps[0]?.name) this.updateRoadName(this.steps[0].name);
        }

        this.etaSeconds = r.duration;
        this.updateETADisplay();
        this.drawRoute(r.geometry.coordinates);
        this.drawTurnMarkers();
        this.updateHUD();

        this.DOMFast.text('dest-name-hud', this.destName || 'Destination');

        // Speed limit by mode
        let speedLimit = this.travelMode === 'driving' ? 60 : this.travelMode === 'cycling' ? 20 : 5;
        const slc = document.getElementById('speed-limit-circle');
        if (slc) {
            slc.classList.remove('speed-limit-hidden');
            this.DOMFast.text('speed-limit-val', speedLimit);
        }

        // Trigger AR build
        if (window.ARScene?.buildPath) window.ARScene.buildPath();

        const p = document.getElementById('route-alternatives-panel');
        if (p) p.classList.add('alt-hidden');
    },

    showRouteAlts(routes) {
        const p = document.getElementById('route-alternatives-panel');
        if (!p) return;
        p.innerHTML = '';
        p.classList.remove('alt-hidden');
        routes.forEach((r, i) => {
            const c = document.createElement('div');
            c.className = `route-card ${i === 0 ? 'route-card-selected' : ''}`;
            const label = i === 0 ? '⚡ Fastest' : i === 1 ? '🗺 Alternative' : `Route ${i + 1}`;
            c.innerHTML = `<div class="route-card-label">${label}</div><div class="route-card-time">${Math.round(r.duration / 60)} min</div><div class="route-card-dist">${(r.distance / 1000).toFixed(1)} km</div>`;
            c.addEventListener('click', () => {
                p.querySelectorAll('.route-card').forEach(x => x.classList.remove('route-card-selected'));
                c.classList.add('route-card-selected');
                this.selectRoute(i);
            });
            p.appendChild(c);
        });
        setTimeout(() => p.classList.add('alt-hidden'), 14000);
    },

    // ════════════════════════════════════════════════════════
    // WEATHER
    // ════════════════════════════════════════════════════════
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

                document.getElementById('weather-icon').innerText = icon;
                document.getElementById('weather-text').innerText = text;
                document.getElementById('weather-temp').innerText = `${temp}°C`;
                const banner = document.getElementById('weather-banner');
                if (banner) { banner.classList.remove('weather-hidden'); banner.classList.add('weather-visible'); }

                if (code >= 61 && this.audioEnabled) {
                    setTimeout(() => this.speak(`Weather warning: ${text} conditions. Drive carefully.`), 3500);
                }
            }
        } catch (e) {}
    },

    updateRoadName(name) {
        this.currentRoadName = name || '--';
        this.DOMFast.text('road-name', this.currentRoadName);
    },

    // ════════════════════════════════════════════════════════
    // SPATIAL ANCHOR — Converts GPS to local AR coordinates
    // ════════════════════════════════════════════════════════
    latLonToAnchor(lat, lon, anchorLat, anchorLon) {
        if (!anchorLat || !anchorLon) return { x: 0, z: 0 };
        const R = 6378137;
        const dLat = (lat - anchorLat) * Math.PI / 180;
        const dLon = (lon - anchorLon) * Math.PI / 180;
        const cosLat = Math.cos(anchorLat * Math.PI / 180);
        return { x: R * dLon * cosLat, z: -(R * dLat) };
    },

    latLonToLocal(lat, lon) {
        return this.latLonToAnchor(lat, lon, this.originLat, this.originLon);
    },

    // ════════════════════════════════════════════════════════
    // MINIMAP
    // ════════════════════════════════════════════════════════
    initMiniMap(lat, lon) {
        const w = document.getElementById('minimap-wrapper');
        if (w) { w.classList.remove('nav-hidden'); w.classList.add('nav-visible'); }
        if (this.mapInstance) return;

        this.mapInstance = L.map('minimap', {
            zoomControl: false, attributionControl: false,
            dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false
        }).setView([lat, lon], 16);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(this.mapInstance);

        const ic = L.divIcon({
            className: 'custom-div-icon',
            html: '<div class="user-marker-dot"><div class="user-marker-pulse"></div></div>',
            iconSize: [16, 16], iconAnchor: [8, 8]
        });
        this.userMarker = L.marker([lat, lon], { icon: ic }).addTo(this.mapInstance);

        document.getElementById('minimap-wrapper').addEventListener('click', e => { e.stopPropagation(); this.toggleFullMap(); });

        window.GPS.onUpdate((t, d) => {
            if (t !== 'position') return;
            const now = Date.now();

            // Smooth marker
            this.userMarker.setLatLng([d.lat, d.lon]);
            if (this.userMarker._icon) {
                this.userMarker._icon.style.transition = 'transform 0.15s linear';
                this.userMarker._icon.style.transform = `rotate(${window.GPS.smoothHeading}deg)`;
            }

            // Heading-up minimap rotation
            const mapEl = document.getElementById('minimap');
            if (mapEl && window.GPS.smoothHeading != null) {
                mapEl.style.transform = `rotate(${-window.GPS.smoothHeading}deg)`;
                mapEl.style.transformOrigin = 'center center';
            }

            // Pan map at max 3fps to avoid jank
            if (!this.lastMapPan || now - this.lastMapPan >= 333) {
                this.mapInstance.panTo([d.lat, d.lon], { animate: true, duration: 0.33, easeLinearity: 1 });
                this.lastMapPan = now;
            }

            if (this.fullUserMarker) this.fullUserMarker.setLatLng([d.lat, d.lon]);

            // Navigation check at 5fps
            if (!this.lastCheckTime || now - this.lastCheckTime >= 200) {
                this.lastCheckTime = now;
                this.checkProgress(d.lat, d.lon);
            }
        });
    },

    toggleFullMap() {
        const o = document.getElementById('fullscreen-map-overlay');
        if (!o) return;
        if (o.classList.contains('fullmap-open')) {
            o.classList.remove('fullmap-open'); o.classList.add('fullmap-closed');
        } else {
            o.classList.remove('fullmap-closed'); o.classList.add('fullmap-open');
            if (!this.fullMapInstance) this.initFullMap();
            else {
                this.fullMapInstance.invalidateSize();
                if (window.GPS.currentLat) this.fullMapInstance.setView([window.GPS.currentLat, window.GPS.currentLon], 15);
            }
        }
    },

    initFullMap() {
        this.fullMapInstance = L.map('fullscreen-map', {
            zoomControl: true, attributionControl: false, dragging: true,
            scrollWheelZoom: true, touchZoom: true
        }).setView([window.GPS.currentLat || 0, window.GPS.currentLon || 0], 15);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(this.fullMapInstance);

        const ic = L.divIcon({ className: 'custom-div-icon', html: '<div class="user-marker-dot"><div class="user-marker-pulse"></div></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
        this.fullUserMarker = L.marker([window.GPS.currentLat || 0, window.GPS.currentLon || 0], { icon: ic }).addTo(this.fullMapInstance);

        if (this.pathCoordinates.length) {
            const ll = this.pathCoordinates.map(c => [c.lat, c.lon]);
            this.fullRouteLayer = L.polyline(ll, { color: '#00b8ff', weight: 5, opacity: 0.9 }).addTo(this.fullMapInstance);
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
        if (this.routeLayer && this.mapInstance) this.mapInstance.removeLayer(this.routeLayer);
        const ll = coords.map(c => [c[1], c[0]]);
        this.routeLayer = L.polyline(ll, { color: '#00b8ff', weight: 5, opacity: 0.85 }).addTo(this.mapInstance);
        this.mapInstance.fitBounds(this.routeLayer.getBounds(), { padding: [12, 12] });
        if (this.fullMapInstance) {
            if (this.fullRouteLayer) this.fullMapInstance.removeLayer(this.fullRouteLayer);
            this.fullRouteLayer = L.polyline(ll, { color: '#00b8ff', weight: 5, opacity: 0.9 }).addTo(this.fullMapInstance);
        }
    },

    drawTurnMarkers() {
        this.turnMarkers.forEach(m => { try { this.mapInstance.removeLayer(m); } catch (e) {} });
        this.turnMarkers = [];
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
        this.fullTurnMarkers.forEach(m => { try { this.fullMapInstance.removeLayer(m); } catch (e) {} });
        this.fullTurnMarkers = [];
        this.steps.forEach((s, i) => {
            if (i === 0) return;
            const loc = s.maneuver.location, mod = s.maneuver.modifier || 'straight', instr = s.maneuver.instruction || '';
            let a = '⬆'; if (mod.includes('left')) a = '⬅'; else if (mod.includes('right')) a = '➡'; else if (mod.includes('uturn')) a = '↩';
            const ic = L.divIcon({ className: 'custom-div-icon', html: `<div class="turn-marker-dot-lg">${a}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
            this.fullTurnMarkers.push(L.marker([loc[1], loc[0]], { icon: ic }).addTo(this.fullMapInstance).bindPopup(instr));
        });
    },

    // ════════════════════════════════════════════════════════
    // ROUTE SNAPPING — Vector projection with look-ahead
    // ════════════════════════════════════════════════════════
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
        // Look-ahead compensation for GPS hardware latency
        const spd = window.GPS.speed || 0;
        const lookAheadM = spd * 0.35;
        let pLat = lat, pLon = lon;
        if (lookAheadM > 0) {
            const R = 6378137;
            const hr = (window.GPS.smoothHeading || 0) * Math.PI / 180;
            pLat += (lookAheadM * Math.cos(hr)) / R * (180 / Math.PI);
            pLon += (lookAheadM * Math.sin(hr)) / (R * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);
        }

        let minCost = Infinity;
        let bestIdx = this.lastSnapIndex || 0;
        let bestSnap = { lat: pLat, lon: pLon, t: 0 };
        const h = window.GPS.smoothHeading || 0;

        // Wider search window: -30 backward, +200 forward
        const spdAdapt = Math.max(50, Math.min(300, spd * 15));
        const start = Math.max(0, bestIdx - 40);
        const end = Math.min(this.pathCoordinates.length - 1, bestIdx + Math.round(spdAdapt));

        for (let i = start; i < end; i++) {
            const p1 = this.pathCoordinates[i], p2 = this.pathCoordinates[i + 1];
            if (!p2) continue;
            const proj = this.projectPoint(pLat, pLon, p1, p2);
            const dist = this.haversine(pLat, pLon, proj.lat, proj.lon);
            const b = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);
            const bx = Math.sin(b * Math.PI / 180), by = Math.cos(b * Math.PI / 180);
            const hx = Math.sin(h * Math.PI / 180), hy = Math.cos(h * Math.PI / 180);
            const dot = bx * hx + by * hy;
            const dotPenalty = dot < 0 ? 60 : Math.max(1, 1.5 - dot);
            const cost = dist * dotPenalty;
            if (cost < minCost) { minCost = cost; bestIdx = i; bestSnap = proj; }
        }

        // Global fallback if way off route
        if (minCost > 2000) {
            for (let i = 0; i < this.pathCoordinates.length - 1; i++) {
                const p1 = this.pathCoordinates[i], p2 = this.pathCoordinates[i + 1];
                const proj = this.projectPoint(pLat, pLon, p1, p2);
                const dist = this.haversine(pLat, pLon, proj.lat, proj.lon);
                const b = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);
                const bx = Math.sin(b * Math.PI / 180), by = Math.cos(b * Math.PI / 180);
                const hx = Math.sin(h * Math.PI / 180), hy = Math.cos(h * Math.PI / 180);
                const dot = bx * hx + by * hy;
                const cost = dist * (dot < 0 ? 10 : Math.max(1, 1.2 - dot));
                if (cost < minCost) { minCost = cost; bestIdx = i; bestSnap = proj; }
            }
        }

        if (!this.snapHistory) this.snapHistory = [];
        this.snapHistory.push(bestSnap);
        if (this.snapHistory.length > 3) this.snapHistory.shift();

        let avgLat = 0, avgLon = 0;
        for (let s of this.snapHistory) { avgLat += s.lat; avgLon += s.lon; }
        bestSnap.lat = avgLat / this.snapHistory.length;
        bestSnap.lon = avgLon / this.snapHistory.length;

        this.lastSnapIndex = bestIdx;
        return {
            index: bestIdx,
            distance: this.haversine(lat, lon, bestSnap.lat, bestSnap.lon),
            snappedLat: bestSnap.lat, snappedLon: bestSnap.lon,
            t: bestSnap.t
        };
    },

    calcRemaining(snap) {
        if (!this.pathCoordinates[snap.index]) return 0;
        let d = this.pathCoordinates[snap.index].cumulativeDist || 0;
        const p1 = this.pathCoordinates[snap.index], p2 = this.pathCoordinates[snap.index + 1];
        if (p2) {
            const segDist = this.haversine(p1.lat, p1.lon, p2.lat, p2.lon);
            d -= segDist * snap.t;
        }
        return Math.max(0, d);
    },

    // ════════════════════════════════════════════════════════
    // VOICE INSTRUCTION GENERATOR
    // ════════════════════════════════════════════════════════
    buildVoiceInstruction(step) {
        const mod = step.maneuver.modifier || 'straight';
        const mType = step.maneuver.type || '';
        const roadName = step.name || '';
        const rdText = roadName ? ` onto ${roadName}` : '';

        switch (mType) {
            case 'turn':
                if (mod.includes('sharp left')) return `Make a sharp left${rdText}`;
                if (mod.includes('slight left')) return `Turn slightly left${rdText}`;
                if (mod.includes('left')) return `Turn left${rdText}`;
                if (mod.includes('sharp right')) return `Make a sharp right${rdText}`;
                if (mod.includes('slight right')) return `Turn slightly right${rdText}`;
                if (mod.includes('right')) return `Turn right${rdText}`;
                if (mod.includes('uturn')) return `Make a U-turn`;
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
                return `You have arrived`;
            case 'roundabout':
            case 'rotary':
                const exit = step.maneuver.exit || '';
                return `At the roundabout, take ${exit ? this.ordinal(exit) + ' exit' : 'the exit'}${rdText}`;
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
                return `Continue at the fork`;
            case 'end of road':
                if (mod.includes('left')) return `At road end, turn left${rdText}`;
                if (mod.includes('right')) return `At road end, turn right${rdText}`;
                return `At road end, continue`;
            default:
                if (mod.includes('sharp left')) return `Sharp left${rdText}`;
                if (mod.includes('slight left')) return `Slight left${rdText}`;
                if (mod.includes('left')) return `Turn left${rdText}`;
                if (mod.includes('sharp right')) return `Sharp right${rdText}`;
                if (mod.includes('slight right')) return `Slight right${rdText}`;
                if (mod.includes('right')) return `Turn right${rdText}`;
                if (mod.includes('uturn')) return `Make a U-turn`;
                return `Continue${rdText}`;
        }
    },

    ordinal(n) {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    },

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

    // ════════════════════════════════════════════════════════
    // MAIN NAVIGATION LOOP — Called at 5fps from GPS listener
    // ════════════════════════════════════════════════════════
    checkProgress(lat, lon) {
        if (this.pathCoordinates.length < 2) return;

        const snap = this.snapToRoute(lat, lon);
        this.remainingDistance = this.calcRemaining(snap);

        const snapLat = snap.snappedLat || lat;
        const snapLon = snap.snappedLon || lon;

        // ── Arrival ──
        if (this.remainingDistance < 15) {
            this.DOMFast.text('turn-dist', '0m');
            this.DOMFast.text('road-name', 'Arrived! 🎯');
            this.setHUDArrow('straight');
            if (this.audioEnabled) this.speak('You have arrived at your destination.');
            if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
            return;
        }

        // ══ OFF-ROUTE DETECTION (Time-based & Heading-based) ══
        const rerouteThreshold = this.travelMode === 'walking' ? 18 : this.travelMode === 'cycling' ? 22 : 30;
        const spdMs = window.GPS.speed || 0;

        let isWrongWay = false;
        if (snap.index < this.pathCoordinates.length - 1 && spdMs > 1.5) {
            const p1 = this.pathCoordinates[snap.index];
            const p2 = this.pathCoordinates[snap.index + 1];
            const routeBearing = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);
            let diff = Math.abs(window.GPS.smoothHeading - routeBearing);
            if (diff > 180) diff = 360 - diff;
            
            if (!this.headingDeviations) this.headingDeviations = [];
            this.headingDeviations.push(diff);
            if (this.headingDeviations.length > 5) this.headingDeviations.shift();
            
            const avgDiff = this.headingDeviations.reduce((a,b)=>a+b,0) / this.headingDeviations.length;
            isWrongWay = avgDiff > 90;
        } else {
            this.headingDeviations = [];
        }

        const isOffRoute = snap.distance > rerouteThreshold || (isWrongWay && snap.distance > 8);

        const wwAlert = document.getElementById('wrong-way-alert');
        if (isWrongWay && spdMs > 1.5) {
            if (wwAlert && wwAlert.classList.contains('wrong-way-hidden')) {
                wwAlert.classList.remove('wrong-way-hidden');
            }
            // Add direction arrow to banner based on relative bearing
            const wwArrow = document.getElementById('wrong-way-arrow');
            if (wwArrow) {
                const p1 = this.pathCoordinates[snap.index];
                const p2 = this.pathCoordinates[snap.index + 1];
                const routeBearing = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);
                let rel = routeBearing - window.GPS.smoothHeading;
                if (rel < -180) rel += 360;
                if (rel > 180) rel -= 360;
                wwArrow.style.transform = `rotate(${rel}deg)`;
            }
        } else {
            if (wwAlert && !wwAlert.classList.contains('wrong-way-hidden')) {
                wwAlert.classList.add('wrong-way-hidden');
            }
        }

        if (isOffRoute) {
            if (!this.offRouteStartTime) this.offRouteStartTime = Date.now();
            const offDuration = Date.now() - this.offRouteStartTime;

            // Warn after 1.5 seconds
            const warnTime = this.travelMode === 'walking' ? 2500 : 1200;
            if (offDuration > warnTime && !this.offRouteWarned) {
                this.offRouteWarned = true;
                if (isWrongWay) {
                    const p1 = this.pathCoordinates[snap.index];
                    const p2 = this.pathCoordinates[snap.index + 1];
                    const routeBearing = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);
                    let rel = routeBearing - window.GPS.smoothHeading;
                    if (rel < -180) rel += 360;
                    if (rel > 180) rel -= 360;
                    const dirStr = rel > 0 ? "right" : "left";
                    if (this.audioEnabled) this.speak(`Wrong way. Turn ${dirStr} to return to the route.`);
                } else {
                    if (this.audioEnabled) this.speak('Return to the route.');
                }
            }

            // Reroute after 3 seconds of continuous off-route
            const rerouteTime = this.travelMode === 'walking' ? 4000 : 2200;
            if (offDuration > rerouteTime && !this.recalculating) {
                this.recalculating = true;
                this.offRouteStartTime = null;
                this.offRouteWarned = false;

                const msg = isWrongWay ? 'Wrong way. Recalculating.' : 'Recalculating.';
                if (this.audioEnabled) this.speak(msg);
                this.DOMFast.text('road-name', '↻ Rerouting...');

                this.fetchRoute(lat, lon, this.destLat, this.destLon, true)
                    .then(() => { this.recalculating = false; })
                    .catch(() => { this.recalculating = false; });
                return;
            }
        } else {
            // Back on route — reset timers
            this.offRouteStartTime = null;
            this.offRouteWarned = false;
        }

        if (this.currentStepIndex >= this.steps.length) return;

        const step = this.steps[this.currentStepIndex];
        const sLat = step.maneuver.location[1], sLon = step.maneuver.location[0];
        const distToTurn = this.haversine(snapLat, snapLon, sLat, sLon);
        const mod = step.maneuver.modifier || 'straight';

        // ── DOM updates at ~4fps ──
        const now = Date.now();
        if (now - (this.lastUIDraw || 0) >= 250) {
            this.lastUIDraw = now;

            if (step.name) this.updateRoadName(step.name);
            this.DOMFast.text('turn-dist', this.fmt(distToTurn));

            // FIXED: Update both HUD arrows (was only updating one)
            this.setHUDArrow(mod);

            // Speed warning
            const kmh = window.GPS.speed * 3.6;
            const limit = distToTurn > 500 ? 120 : 80;
            if (kmh > limit) {
                const sw = document.getElementById('speed-warning');
                if (sw) { sw.classList.remove('speed-warn-hidden'); sw.classList.add('speed-warn-visible'); }
                if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
            } else {
                const sw = document.getElementById('speed-warning');
                if (sw) { sw.classList.remove('speed-warn-visible'); sw.classList.add('speed-warn-hidden'); }
            }

            this.updateLanes(step, distToTurn);
            this.updateETAFromSpeed();
        }

        // ── Voice guidance ──
        if (this.audioEnabled) {
            const voiceInstr = this.buildVoiceInstruction(step);
            if (distToTurn < 600 && distToTurn > 400 && !this.announced500m) {
                this.announced500m = true;
                this.speak(`In ${Math.round(distToTurn)} meters, ${voiceInstr}`);
            }
            if (distToTurn < 220 && distToTurn > 120 && !this.announced200m) {
                this.announced200m = true;
                this.speak(`In ${Math.round(distToTurn)} meters, ${voiceInstr}`);
            }
            if (distToTurn < 100 && distToTurn > 60 && !this.announced100m) {
                this.announced100m = true;
                this.speak(`In ${Math.round(distToTurn)} meters, ${voiceInstr}`);
            }
            if (distToTurn < 45 && distToTurn > 10 && !this.announced50m) {
                this.announced50m = true;
                this.speak(`Now, ${voiceInstr}`);
            }
            if (this.travelMode === 'walking' && distToTurn < 25 && distToTurn > 8 && !this.announcedWalk) {
                this.announcedWalk = true;
                this.speak(voiceInstr);
            }
        }

        // ── Step advance ──
        const baseRadius = this.travelMode === 'walking' ? 5 : 9;
        const radius = Math.min(35, Math.max(baseRadius, Math.min(window.GPS.currentAccuracy || 12, 20)) + spdMs * 0.8);

        if (distToTurn < radius) {
            this.currentStepIndex++;
            this.announced500m = this.announced200m = this.announced100m = this.announced50m = false;
            this.announcedWalk = false;

            if (this.currentStepIndex < this.steps.length) {
                const nextStep = this.steps[this.currentStepIndex];
                const nm = nextStep.maneuver.modifier || 'straight';
                this.setHUDArrow(nm);

                // Rebuild AR path on step advance
                if (window.ARScene?.buildPath) {
                    window.ARScene.buildPath();
                    this.lastArBuildLat = lat;
                    this.lastArBuildLon = lon;
                }

                if (this.audioEnabled) {
                    const nLat = nextStep.maneuver.location[1], nLon = nextStep.maneuver.location[0];
                    const nDist = this.haversine(lat, lon, nLat, nLon);
                    const nextVoice = this.buildVoiceInstruction(nextStep);
                    if (nDist > 25) {
                        this.speak(`Next, in ${Math.round(nDist)} meters, ${nextVoice}`);
                    } else {
                        this.speak(nextVoice);
                    }
                }
            }
        }

        // Rebuild AR arrows based on distance or sharp heading changes
        if (!this.lastArBuildLat) {
            this.lastArBuildLat = lat; this.lastArBuildLon = lon;
            this.lastArBuildHeading = window.GPS.smoothHeading;
        } else {
            const rebuildDist = spdMs > 10 ? 40 : spdMs > 3 ? 20 : 10;
            const d = this.haversine(lat, lon, this.lastArBuildLat, this.lastArBuildLon);
            let hDiff = Math.abs(window.GPS.smoothHeading - (this.lastArBuildHeading || 0));
            if (hDiff > 180) hDiff = 360 - hDiff;
            
            if ((d > rebuildDist || hDiff > 30) && window.ARScene?.buildPath) {
                window.ARScene.buildPath();
                this.lastArBuildLat = lat; this.lastArBuildLon = lon;
                this.lastArBuildHeading = window.GPS.smoothHeading;
            }
        }
    },

    // ════════════════════════════════════════════════════════
    // HUD ARROW UPDATE — FIXED: Updates BOTH arrow elements
    // ════════════════════════════════════════════════════════
    setHUDArrow(mod) {
        const arrowEl = document.getElementById('turn-arrow-2d');
        const badgeEl = document.getElementById('badge-arrow');

        let deg = 0;
        if (mod.includes('uturn')) deg = 180;
        else if (mod.includes('sharp left')) deg = -135;
        else if (mod.includes('slight left')) deg = -45;
        else if (mod.includes('left')) deg = -90;
        else if (mod.includes('sharp right')) deg = 135;
        else if (mod.includes('slight right')) deg = 45;
        else if (mod.includes('right')) deg = 90;

        [arrowEl, badgeEl].forEach(el => {
            if (!el) return;
            const svg = el.querySelector('.nav-arrow');
            if (svg) svg.style.transform = `rotate(${deg}deg)`;
        });
    },

    // Keep old setArrow for any external calls
    setArrow(id, base, mod) { this.setHUDArrow(mod); },

    // ── Lane guidance ──
    updateLanes(step, dist) {
        const c = document.getElementById('lane-guidance'); if (!c) return;
        if (dist > 280 || !step.intersections?.length) { c.classList.add('lane-hidden'); return; }
        const inter = step.intersections[step.intersections.length - 1];
        if (!inter.lanes?.length) { c.classList.add('lane-hidden'); return; }
        c.classList.remove('lane-hidden'); c.innerHTML = '';
        inter.lanes.forEach(l => {
            const d = document.createElement('div');
            d.className = `lane-arrow ${l.valid ? 'lane-active' : 'lane-inactive'}`;
            let a = '↑';
            if (l.indications?.includes('left')) a = '←';
            else if (l.indications?.includes('right')) a = '→';
            else if (l.indications?.includes('slight left')) a = '↖';
            else if (l.indications?.includes('slight right')) a = '↗';
            d.innerText = a;
            c.appendChild(d);
        });
    },

    // ── ETA ──
    updateETAFromSpeed() {
        const s = window.GPS.speed || 0;
        if (s > 0.3) {
            this.etaSeconds = this.remainingDistance / s;
        } else {
            const avgSpd = this.travelMode === 'walking' ? 1.39 : this.travelMode === 'cycling' ? 4.17 : 8.33;
            this.etaSeconds = this.remainingDistance / avgSpd;
        }
        this.updateETADisplay();
    },

    updateETADisplay() {
        const m = Math.round(this.etaSeconds / 60);
        const arrival = new Date(Date.now() + this.etaSeconds * 1000);
        const h = arrival.getHours(), mi = arrival.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        this.DOMFast.text('bottom-time', `${h % 12 || 12}:${mi.toString().padStart(2, '0')} ${ampm}`);
        const durStr = m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
        this.DOMFast.text('remaining-time', durStr);
        this.DOMFast.text('remaining-eta', durStr);
        this.DOMFast.text('total-dist-val', this.fmt(this.remainingDistance));
    },

    fmt(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + 'm'; },
    updateHUD() { this.DOMFast.text('total-dist-val', this.fmt(this.totalDistance)); },

    haversine(a, b, c, d) {
        const R = 6371e3, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180;
        const dp = (c - a) * Math.PI / 180, dl = (d - b) * Math.PI / 180;
        const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    },

    speak(t) {
        if (!this.audioEnabled || !window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(t);
        u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0; u.lang = 'en-US';
        // Delay slightly to avoid cutting off previous speech
        setTimeout(() => window.speechSynthesis.speak(u), 80);
    },

    destroy() {
        this.steps = []; this.pathCoordinates = []; this.allRoutes = [];
        this.currentStepIndex = 0;
        this.offRouteStartTime = null; this.offRouteWarned = false;
        this.DOMFast.cache = {};
        try { if (this.routeLayer && this.mapInstance) this.mapInstance.removeLayer(this.routeLayer); } catch (e) {}
        try { if (this.fullRouteLayer && this.fullMapInstance) this.fullMapInstance.removeLayer(this.fullRouteLayer); } catch (e) {}
        this.turnMarkers.forEach(m => { try { this.mapInstance.removeLayer(m); } catch (e) {} });
        this.fullTurnMarkers.forEach(m => { try { this.fullMapInstance?.removeLayer(m); } catch (e) {} });
        this.routeLayer = null; this.fullRouteLayer = null;
        this.turnMarkers = []; this.fullTurnMarkers = [];
        this.lastArBuildLat = null; this.lastArBuildLon = null;
        if (window.ARScene?.resetAnchor) window.ARScene.resetAnchor();
    }
};
