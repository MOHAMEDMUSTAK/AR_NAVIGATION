// route.js — Ultra Route Engine v3
// ETA, Road Names, Weather, Lane Guidance, Fullscreen Map, Snapping

window.RouteManager = {
    steps:[], pathCoordinates:[], totalDistance:0, remainingDistance:0, currentStepIndex:0,
    mapInstance:null, fullMapInstance:null, routeLayer:null, fullRouteLayer:null,
    userMarker:null, fullUserMarker:null, turnMarkers:[], fullTurnMarkers:[],
    originLat:null, originLon:null, allRoutes:[], selectedRouteIndex:0, etaSeconds:0,
    audioEnabled:false, announced500m:false, announced200m:false, announced50m:false,
    recalculating:false, recalcCooldown:0,
    destLat:null, destLon:null, destName:'', isFullMapOpen:false,
    currentRoadName: '--', speedLimitKmh: 0,
    
    DOMFast: {
        cache: {},
        text(id, val) { if (this.cache[id] === val) return; this.cache[id] = val; const el = document.getElementById(id); if (el) el.innerText = val; },
        class(id, addC, rmC) { const k = id+'_c'; if (this.cache[k] === addC) return; this.cache[k] = addC; const el = document.getElementById(id); if (el) { if (rmC) el.classList.remove(rmC); el.classList.add(addC); } }
    },

    // ── FETCH ROUTE ──
    async fetchRoute(startLat, startLon, endLat, endLon, isReroute=false) {
        this.destLat=endLat; this.destLon=endLon;
        this.initMiniMap(startLat, startLon);

        const url = `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?steps=true&geometries=geojson&overview=full&annotations=distance,duration`;
        if (!isReroute) { this.originLat=startLat; this.originLon=startLon; }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500); // 3.5s aggressive timeout

        let res;
        try {
            res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
        } catch(e) {
            clearTimeout(timeoutId);
            throw new Error("Routing server took too long. Please try again.");
        }
        
        const data = await res.json();
        if (data.code !== 'Ok' || !data.routes?.length) throw new Error("Route not found.");

        this.allRoutes = data.routes;
        if (data.routes.length > 1 && !isReroute) this.showRouteAlts(data.routes);
        this.selectRoute(0);

        // Fetch weather for destination
        this.fetchWeather(endLat, endLon);
        return true;
    },

    selectRoute(i) {
        if (i >= this.allRoutes.length) return;
        this.selectedRouteIndex = i;
        const r = this.allRoutes[i];
        this.totalDistance = r.distance;
        this.remainingDistance = r.distance;
        this.pathCoordinates = r.geometry.coordinates.map(c => ({ lon:c[0], lat:c[1] }));
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
            // Get initial road name
            if (this.steps[0]?.name) this.updateRoadName(this.steps[0].name);
        }

        this.etaSeconds = r.duration;
        this.updateETADisplay();
        this.drawRoute(r.geometry.coordinates);
        this.drawTurnMarkers();
        this.updateHUD();
        if (window.ARScene?.buildPath) window.ARScene.buildPath();
        const p = document.getElementById('route-alternatives-panel');
        if (p) p.classList.add('alt-hidden');
    },

    showRouteAlts(routes) {
        const p = document.getElementById('route-alternatives-panel');
        if (!p) return; p.innerHTML = ''; p.classList.remove('alt-hidden');
        routes.forEach((r, i) => {
            const c = document.createElement('div');
            c.className = `route-card ${i===0?'route-card-selected':''}`;
            c.innerHTML = `<div class="route-card-label">${i===0?'Fastest':i===1?'Alternative':`Route ${i+1}`}</div><div class="route-card-time">${Math.round(r.duration/60)} min</div><div class="route-card-dist">${(r.distance/1000).toFixed(1)} km</div>`;
            c.addEventListener('click', () => { p.querySelectorAll('.route-card').forEach(x=>x.classList.remove('route-card-selected')); c.classList.add('route-card-selected'); this.selectRoute(i); });
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

                // Voice weather warning for bad conditions
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

    // ── COORDS ──
    latLonToLocal(lat, lon) {
        if (!this.originLat) return {x:0,z:0};
        const R=6378137, dLat=(lat-this.originLat)*Math.PI/180, dLon=(lon-this.originLon)*Math.PI/180, l1=this.originLat*Math.PI/180;
        return { x:R*dLon*Math.cos(l1), z:-(R*dLat) };
    },

    // ── MINIMAP ──
    initMiniMap(lat, lon) {
        const w = document.getElementById('minimap-wrapper');
        if (w) { w.classList.remove('nav-hidden'); w.classList.add('nav-visible'); }
        if (this.mapInstance) return;

        this.mapInstance = L.map('minimap', { zoomControl:false, attributionControl:false, dragging:false, scrollWheelZoom:false, doubleClickZoom:false, touchZoom:false }).setView([lat,lon], 16);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom:19 }).addTo(this.mapInstance);

        const ic = L.divIcon({ className:'custom-div-icon', html:'<div class="user-marker-dot"><div class="user-marker-pulse"></div></div>', iconSize:[16,16], iconAnchor:[8,8] });
        this.userMarker = L.marker([lat,lon], {icon:ic}).addTo(this.mapInstance);

        document.getElementById('minimap-wrapper').addEventListener('click', e => { e.stopPropagation(); this.toggleFullMap(); });

        window.GPS.onUpdate((t, d) => {
            if (t==='position') {
                const now = Date.now();
                
                // Add smooth hardware-accelerated gliding to the marker icon
                if (this.userMarker._icon) {
                    this.userMarker._icon.style.transition = 'transform 0.1s linear';
                }
                this.userMarker.setLatLng([d.lat, d.lon]);

                // Throttle the heavy map panning to strictly 1 FPS to prevent main-thread lag
                // Letting Leaflet handle exactly one smooth animation per second
                if (!this.lastMapPan || now - this.lastMapPan >= 1000) {
                    this.mapInstance.setView([d.lat, d.lon], 16, { animate: true, duration: 0.8 });
                    this.lastMapPan = now;
                }

                if (this.fullUserMarker) {
                    if (this.fullUserMarker._icon) this.fullUserMarker._icon.style.transition = 'transform 0.1s linear';
                    this.fullUserMarker.setLatLng([d.lat, d.lon]);
                }
                
                // Fix Lag: Throttle extremely heavy routing calculations to 3 FPS
                if (!this.lastCheckTime || now - this.lastCheckTime >= 333) {
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
            o.classList.remove('fullmap-open'); o.classList.add('fullmap-closed'); this.isFullMapOpen=false;
        } else {
            o.classList.remove('fullmap-closed'); o.classList.add('fullmap-open'); this.isFullMapOpen=true;
            if (!this.fullMapInstance) this.initFullMap();
            else { this.fullMapInstance.invalidateSize(); if (window.GPS.currentLat) this.fullMapInstance.setView([window.GPS.currentLat, window.GPS.currentLon], 15); }
        }
    },

    initFullMap() {
        this.fullMapInstance = L.map('fullscreen-map', { zoomControl:true, attributionControl:false, dragging:true, scrollWheelZoom:true, touchZoom:true }).setView([window.GPS.currentLat||0, window.GPS.currentLon||0], 15);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom:19 }).addTo(this.fullMapInstance);

        const ic = L.divIcon({ className:'custom-div-icon', html:'<div class="user-marker-dot"><div class="user-marker-pulse"></div></div>', iconSize:[18,18], iconAnchor:[9,9] });
        this.fullUserMarker = L.marker([window.GPS.currentLat||0, window.GPS.currentLon||0], {icon:ic}).addTo(this.fullMapInstance);

        if (this.pathCoordinates.length) {
            const ll = this.pathCoordinates.map(c=>[c.lat,c.lon]);
            this.fullRouteLayer = L.polyline(ll, {color:'#b000ff',weight:5,opacity:.9}).addTo(this.fullMapInstance);
            this.fullMapInstance.fitBounds(this.fullRouteLayer.getBounds(), {padding:[40,40]});
        }

        this.drawFullTurnMarkers();

        if (this.destLat) {
            const di = L.divIcon({ className:'custom-div-icon', html:'<div class="dest-marker-dot">📍</div>', iconSize:[28,28], iconAnchor:[14,28] });
            L.marker([this.destLat,this.destLon], {icon:di}).addTo(this.fullMapInstance).bindPopup(this.destName||'Destination');
        }

        document.getElementById('close-fullmap-btn').addEventListener('click', e => { e.stopPropagation(); this.toggleFullMap(); });
    },

    drawRoute(coords) {
        if (this.routeLayer) this.mapInstance.removeLayer(this.routeLayer);
        const ll = coords.map(c=>[c[1],c[0]]);
        this.routeLayer = L.polyline(ll, {color:'#b000ff',weight:4,opacity:.8}).addTo(this.mapInstance);
        this.mapInstance.fitBounds(this.routeLayer.getBounds(), {padding:[10,10]});
        if (this.fullMapInstance) {
            if (this.fullRouteLayer) this.fullMapInstance.removeLayer(this.fullRouteLayer);
            this.fullRouteLayer = L.polyline(ll, {color:'#b000ff',weight:5,opacity:.9}).addTo(this.fullMapInstance);
        }
    },

    drawTurnMarkers() {
        this.turnMarkers.forEach(m=>this.mapInstance.removeLayer(m)); this.turnMarkers=[];
        this.steps.forEach((s,i) => {
            if (i===0) return;
            const loc=s.maneuver.location, mod=s.maneuver.modifier||'straight';
            let a='⬆'; if (mod.includes('left'))a='⬅'; else if(mod.includes('right'))a='➡'; else if(mod.includes('uturn'))a='↩';
            const ic = L.divIcon({className:'custom-div-icon', html:`<div class="turn-marker-dot">${a}</div>`, iconSize:[18,18], iconAnchor:[9,9]});
            this.turnMarkers.push(L.marker([loc[1],loc[0]], {icon:ic}).addTo(this.mapInstance));
        });
    },

    drawFullTurnMarkers() {
        if (!this.fullMapInstance) return;
        this.fullTurnMarkers.forEach(m=>this.fullMapInstance.removeLayer(m)); this.fullTurnMarkers=[];
        this.steps.forEach((s,i) => {
            if (i===0) return;
            const loc=s.maneuver.location, mod=s.maneuver.modifier||'straight', instr=s.maneuver.instruction||'';
            let a='⬆'; if(mod.includes('left'))a='⬅'; else if(mod.includes('right'))a='➡'; else if(mod.includes('uturn'))a='↩';
            const ic = L.divIcon({className:'custom-div-icon', html:`<div class="turn-marker-dot-lg">${a}</div>`, iconSize:[24,24], iconAnchor:[12,12]});
            this.fullTurnMarkers.push(L.marker([loc[1], loc[0]], {icon:ic}).addTo(this.fullMapInstance).bindPopup(instr));
        });
    },

    // ── SNAPPING (Orthogonal Vector Projection) ──
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
        let minCost = Infinity, bestIdx = this.lastSnapIndex || 0, bestSnap = {lat, lon, t:0};
        let start = Math.max(0, bestIdx - 80);
        let end = Math.min(this.pathCoordinates.length - 1, bestIdx + 150);
        let h = window.GPS.smoothHeading || 0;

        for (let i = start; i < end; i++) {
            const p1 = this.pathCoordinates[i], p2 = this.pathCoordinates[i+1];
            const proj = this.projectPoint(lat, lon, p1, p2);
            const dist = this.haversine(lat, lon, proj.lat, proj.lon);
            const b = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);
            let dH = Math.abs(h - b); if (dH > 180) dH = 360 - dH;
            
            // Extreme exponential penalty for incorrect heading to stop intersection jumping
            const cost = dist * (1 + Math.pow(dH / 30, 4));

            if (cost < minCost) { minCost = cost; bestIdx = i; bestSnap = proj; }
        }

        if (minCost > 2000) {
            for (let i = 0; i < this.pathCoordinates.length - 1; i++) {
                const p1 = this.pathCoordinates[i], p2 = this.pathCoordinates[i+1];
                const proj = this.projectPoint(lat, lon, p1, p2);
                const dist = this.haversine(lat, lon, proj.lat, proj.lon);
                const b = window.GPS.calcBearing(p1.lat, p1.lon, p2.lat, p2.lon);
                let dH = Math.abs(h - b); if (dH > 180) dH = 360 - dH;
                
                const cost = dist * (1 + Math.pow(dH / 45, 2)); // Slightly less strict when doing a full global search

                if (cost < minCost) { minCost = cost; bestIdx = i; bestSnap = proj; }
            }
        }
        
        this.lastSnapIndex = bestIdx;
        return { index: bestIdx, distance: this.haversine(lat, lon, bestSnap.lat, bestSnap.lon), snappedLat: bestSnap.lat, snappedLon: bestSnap.lon, t: bestSnap.t };
    },

    calcRemaining(snap) {
        if (!this.pathCoordinates[snap.index]) return 0;
        let d = this.pathCoordinates[snap.index].cumulativeDist || 0;
        // Subtract the segment fraction we have already traveled
        const p1 = this.pathCoordinates[snap.index], p2 = this.pathCoordinates[snap.index+1];
        if (p2) {
            const segDist = this.haversine(p1.lat, p1.lon, p2.lat, p2.lon);
            d -= (segDist * snap.t);
        }
        return d;
    },

    // ── MAIN NAV LOOP ──
    checkProgress(lat, lon) {
        if (this.recalcCooldown > 0) this.recalcCooldown--;
        const snap = this.snapToRoute(lat, lon);
        this.remainingDistance = this.calcRemaining(snap);
        
        // Snapped virtual location for extremely smooth UI/AR updates
        const sLatVirtual = snap.snappedLat || lat;
        const sLonVirtual = snap.snappedLon || lon;

        // Arrival
        if (this.currentStepIndex >= this.steps.length || this.remainingDistance < 15) {
            this.DOMFast.text('status-text', "🎉 Arrived!");
            this.DOMFast.text('turn-dist', "0m");
            this.DOMFast.text('turn-instruction', "You have arrived");
            this.setArrow('turn-arrow','arrow-3d','straight');
            if (this.audioEnabled) this.speak("You have arrived at your destination.");
            return;
        }

        // Reroute (30m threshold, 5s cooldown)
        if (snap.distance > 30 && !this.recalculating && this.recalcCooldown <= 0) {
            this.recalculating=true; this.recalcCooldown=50;
            this.speak("Recalculating."); this.DOMFast.text('turn-instruction', "Rerouting...");
            this.fetchRoute(lat,lon,this.destLat,this.destLon,true).then(()=>{this.recalculating=false;this.DOMFast.text('status-text', "Navigating");}).catch(()=>{this.recalculating=false;});
            return;
        }

        const step = this.steps[this.currentStepIndex];
        const sLat=step.maneuver.location[1], sLon=step.maneuver.location[0];
        // Use snapped virtual location for buttery smooth UI tracking without jitter
        const distToTurn = this.haversine(sLatVirtual,sLonVirtual,sLat,sLon);
        const mod = step.maneuver.modifier || 'straight';
        
        // Let's use distToTurn for UI drawing
        const dist = distToTurn;

        // Throttle heavy DOM updates to ~3 FPS to prevent lag
        const now = Date.now();
        if (now - (this.lastUIDraw || 0) >= 300) {
            this.lastUIDraw = now;

            if (step.name) this.updateRoadName(step.name);

            this.DOMFast.text('turn-dist', this.fmt(dist));
            this.DOMFast.text('turn-instruction', step.maneuver.instruction || 'Proceed');
            this.setArrow('turn-arrow','arrow-3d', mod);

            const kmh = window.GPS.speed * 3.6;
            const speedLimit = dist > 500 ? 120 : 80;
            if (kmh > speedLimit) {
                this.DOMFast.class('speed-warning', 'speed-warn-visible', 'speed-warn-hidden');
                if (navigator.vibrate) navigator.vibrate([100,50,100]);
            } else {
                this.DOMFast.class('speed-warning', 'speed-warn-hidden', 'speed-warn-visible');
            }

            if (dist < 150) {
                this.setArrow('hud-arrow-3d','mega-arrow', mod);
            }

            this.updateLanes(step, dist);
            this.updateETAFromSpeed();
            this.DOMFast.text('total-dist-val', this.fmt(this.remainingDistance));
            this.DOMFast.text('status-text', "Navigating");
        }

        // Voice
        if (this.audioEnabled) {
            const instr = step.maneuver.instruction || 'Proceed';
            if (dist<500 && dist>300 && !this.announced500m) { this.announced500m=true; this.speak(`In ${Math.round(dist)} meters, ${instr}`); }
            if (dist<200 && dist>100 && !this.announced200m) { this.announced200m=true; this.speak(`In ${Math.round(dist)} meters, ${instr}`); }
            if (dist<50 && dist>15 && !this.announced50m) { this.announced50m=true; this.speak(`Now, ${instr}`); }
        }

        // Step advance with Velocity-Scaled Dynamic Turn Anticipation
        // At 80km/h (22m/s), radius is ~33m. At 10km/h (2.7m/s), radius is ~12m.
        let spdMs = window.GPS.speed || 0;
        const radius = Math.max(8, Math.min((window.GPS.currentAccuracy||10), 20)) + (spdMs * 1.5);
        if (dist < radius) {
            this.currentStepIndex++;
            this.announced500m=this.announced200m=this.announced50m=false;
            if (this.currentStepIndex < this.steps.length) {
                const stepObj = this.steps[this.currentStepIndex];
                const nm = stepObj.maneuver.modifier || 'straight';
                this.setArrow('turn-arrow','arrow-3d', nm);
                
                // Immediately rebuild the AR path and arrows so it continuously updates on screen dynamically
                if (window.ARScene && typeof window.ARScene.buildPath === 'function') {
                    window.ARScene.buildPath();
                    this.lastArBuildLat = lat; this.lastArBuildLon = lon;
                }
                
                // Immediately read out the upcoming turn after we finish the intersection!
                if (this.audioEnabled) {
                    const nLat=stepObj.maneuver.location[1], nLon=stepObj.maneuver.location[0];
                    const nDist = this.haversine(lat,lon,nLat,nLon);
                    
                    let genInstr = '';
                    const mType = stepObj.maneuver.type;
                    const rdName = stepObj.name ? 'onto ' + stepObj.name : '';
                    if (mType === 'turn') genInstr = `Turn ${nm} ${rdName}`;
                    else if (mType === 'new name') genInstr = `Continue ${rdName}`;
                    else if (mType === 'depart') genInstr = `Head ${nm} ${rdName}`;
                    else if (mType === 'arrive') genInstr = `Arrive at destination`;
                    else if (mType === 'roundabout') genInstr = `Take the roundabout and exit ${rdName}`;
                    else if (mType === 'merge') genInstr = `Merge ${nm} ${rdName}`;
                    else if (mType === 'on ramp') genInstr = `Take the ramp ${rdName}`;
                    else if (mType === 'off ramp') genInstr = `Take the exit ${rdName}`;
                    else if (mType === 'fork') genInstr = `Keep ${nm} at the fork ${rdName}`;
                    else if (mType === 'end of road') genInstr = `At the end of the road, turn ${nm} ${rdName}`;
                    else if (nm !== 'straight') genInstr = `Go ${nm} ${rdName}`;
                    else genInstr = `Continue straight ${rdName}`;
                    const nextInstr = stepObj.maneuver.instruction || genInstr.trim();
                    
                    this.speak(`Next, in ${Math.round(nDist)} meters, ${nextInstr}`);
                }
            }
        }

        // Dynamically rebuild the AR arrows every 20 meters traveled so they never get "left behind"
        if (!this.lastArBuildLat) {
            this.lastArBuildLat = lat; this.lastArBuildLon = lon;
        } else {
            const distSinceArBuild = this.haversine(lat, lon, this.lastArBuildLat, this.lastArBuildLon);
            if (distSinceArBuild > 20 && window.ARScene && typeof window.ARScene.buildPath === 'function') {
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
        // Exact rotational degree values mapping 
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
        if (dist>300 || !step.intersections?.length) { c.classList.add('lane-hidden'); return; }
        const inter = step.intersections[step.intersections.length-1];
        if (!inter.lanes?.length) { c.classList.add('lane-hidden'); return; }
        c.classList.remove('lane-hidden'); c.innerHTML='';
        inter.lanes.forEach(l => {
            const d=document.createElement('div');
            d.className=`lane-arrow ${l.valid?'lane-active':'lane-inactive'}`;
            let a='↑'; if(l.indications){if(l.indications.includes('left'))a='←';else if(l.indications.includes('right'))a='→';else if(l.indications.includes('slight left'))a='↖';else if(l.indications.includes('slight right'))a='↗';}
            d.innerText=a; c.appendChild(d);
        });
    },

    // ── ETA ──
    updateETAFromSpeed() {
        const s=window.GPS.speed||0;
        if (s>0.5) this.etaSeconds=this.remainingDistance/s;
        this.updateETADisplay();
    },

    updateETADisplay() {
        const m = Math.round(this.etaSeconds/60);
        const a = new Date(Date.now() + this.etaSeconds * 1000);
        const h = a.getHours(), mi = a.getMinutes(); 
        this.DOMFast.text('bottom-time', `${h%12||12}:${mi.toString().padStart(2,'0')} ${h>=12?'PM':'AM'}`);
        
        let durStr = '';
        if (m < 60) durStr = `${m} min`;
        else durStr = `${Math.floor(m/60)}h ${m%60}m`;
        this.DOMFast.text('remaining-time', durStr);
    },

    fmt(m) { return m>=1000?(m/1000).toFixed(1)+' km':Math.round(m)+'m'; },
    updateHUD() { this.DOMFast.text('total-dist-val', this.fmt(this.totalDistance)); },

    haversine(a,b,c,d) {
        const R=6371e3,p1=a*Math.PI/180,p2=c*Math.PI/180,dp=(c-a)*Math.PI/180,dl=(d-b)*Math.PI/180;
        const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
        return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
    },

    speak(t) { if(!this.audioEnabled||!window.speechSynthesis)return; window.speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(t); u.rate=1; u.lang='en-US'; window.speechSynthesis.speak(u); },

    destroy() {
        this.steps=[]; this.pathCoordinates=[]; this.allRoutes=[]; this.currentStepIndex=0; this.isFullMapOpen=false;
        try{if(this.routeLayer&&this.mapInstance)this.mapInstance.removeLayer(this.routeLayer);if(this.fullRouteLayer&&this.fullMapInstance)this.fullMapInstance.removeLayer(this.fullRouteLayer);}catch(e){}
        this.turnMarkers.forEach(m=>{try{this.mapInstance.removeLayer(m);}catch(e){}});
        this.fullTurnMarkers.forEach(m=>{try{this.fullMapInstance.removeLayer(m);}catch(e){}});
        this.routeLayer=null;this.fullRouteLayer=null;this.turnMarkers=[];this.fullTurnMarkers=[];
    }
};
