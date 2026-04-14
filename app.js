// app.js — Ultimate Orchestrator v3
// Voice Input, Obstacle Detection, Parking, SOS, Trip Stats, Weather, Speed Warning

document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const inputScreen = document.getElementById('input-screen');
    const destInput = document.getElementById('dest-address');
    const suggestionsPanel = document.getElementById('search-suggestions');
    const statusText = document.getElementById('status-text');

    let isNavigating = false, searchTimeout = null;
    let obstacleModel = null, obstacleInterval = null, cameraStream = null;

    // Day/Night
    const h = new Date().getHours();
    if (h < 6 || h > 18) document.body.classList.add('night-mode');

    loadRecent();
    loadParkedCar();

    // ═══ SEARCH AUTOCOMPLETE ════════════════════════════
    destInput.addEventListener('input', () => {
        // Aggressively start GPS lock as soon as user types to save time
        if (window.GPS && !window.GPS.active && typeof window.GPS.init === 'function') window.GPS.init();

        const q = destInput.value.trim();
        if (searchTimeout) clearTimeout(searchTimeout);
        if (q.length < 3) { suggestionsPanel.classList.add('suggestions-hidden'); return; }
        searchTimeout = setTimeout(() => fetchSuggestions(q), 300);
    });

    destInput.addEventListener('keydown', e => { if (e.key==='Enter') { suggestionsPanel.classList.add('suggestions-hidden'); startBtn.click(); } });
    document.addEventListener('click', e => { if (!e.target.closest('.input-group')) suggestionsPanel.classList.add('suggestions-hidden'); });

    async function fetchSuggestions(q) {
        try {
            const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&addressdetails=1`, { headers:{'Accept-Language':'en'} });
            const d = await r.json();
            if (d?.length) { showSuggestions(d); return; }
            const pr = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`);
            const pd = await pr.json();
            if (pd.features?.length) showSuggestions(pd.features.map(f=>({ display_name:f.properties.name+(f.properties.city?`, ${f.properties.city}`:'')+(f.properties.country?`, ${f.properties.country}`:''), lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0] })));
        } catch(e){}
    }

    function showSuggestions(results) {
        suggestionsPanel.innerHTML=''; suggestionsPanel.classList.remove('suggestions-hidden');
        results.forEach(r => {
            const it = document.createElement('div'); it.className='suggestion-item';
            const nm=r.display_name.split(',')[0], dt=r.display_name.split(',').slice(1,3).join(',').trim();
            it.innerHTML=`<div class="suggestion-name">${nm}</div><div class="suggestion-detail">${dt}</div>`;
            it.addEventListener('click', () => { destInput.value=r.display_name; destInput.dataset.lat=r.lat; destInput.dataset.lon=r.lon; suggestionsPanel.classList.add('suggestions-hidden'); });
            suggestionsPanel.appendChild(it);
        });
    }

    // ═══ VOICE INPUT ════════════════════════════════════
    const voiceInputBtn = document.getElementById('voice-input-btn');
    if (voiceInputBtn && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
        voiceInputBtn.addEventListener('click', () => {
            const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
            const recognition = new SR();
            recognition.lang = 'en-US';
            recognition.interimResults = false;
            recognition.maxAlternatives = 1;

            voiceInputBtn.classList.add('listening');

            recognition.onresult = (e) => {
                const transcript = e.results[0][0].transcript;
                destInput.value = transcript;
                voiceInputBtn.classList.remove('listening');
                // Auto-search
                fetchSuggestions(transcript);
            };

            recognition.onerror = () => voiceInputBtn.classList.remove('listening');
            recognition.onend = () => voiceInputBtn.classList.remove('listening');

            recognition.start();
        });
    } else if (voiceInputBtn) {
        voiceInputBtn.style.display = 'none';
    }

    // ═══ RECENT DESTINATIONS ════════════════════════════
    function loadRecent() {
        try {
            const rec = JSON.parse(localStorage.getItem('astranav_recent') || '[]');
            if (!rec.length) return;
            const sec = document.getElementById('recent-destinations'), list = document.getElementById('recent-list');
            sec.classList.remove('recent-hidden'); list.innerHTML='';
            rec.slice(0,5).forEach(d => {
                const it=document.createElement('div'); it.className='recent-item';
                it.innerText = d.name.length>38 ? d.name.substring(0,38)+'...' : d.name;
                it.addEventListener('click', () => { destInput.value=d.name; destInput.dataset.lat=d.lat; destInput.dataset.lon=d.lon; });
                list.appendChild(it);
            });
        } catch(e){}
    }

    function saveRecent(name, lat, lon) {
        try { let r=JSON.parse(localStorage.getItem('astranav_recent')||'[]'); r=r.filter(d=>d.name!==name); r.unshift({name,lat,lon}); localStorage.setItem('astranav_recent',JSON.stringify(r.slice(0,5))); } catch(e){}
    }

    // ═══ PARKED CAR ═════════════════════════════════════
    function loadParkedCar() {
        try {
            const p = JSON.parse(localStorage.getItem('astranav_parked'));
            if (p) {
                const sec = document.getElementById('parked-car');
                sec.classList.remove('parked-hidden');
                document.getElementById('go-to-car-btn').addEventListener('click', () => {
                    destInput.value = 'My Parked Car';
                    destInput.dataset.lat = p.lat;
                    destInput.dataset.lon = p.lon;
                    startBtn.click();
                });
            }
        } catch(e){}
    }

    function saveParkingSpot() {
        if (!window.GPS.currentLat) return;
        localStorage.setItem('astranav_parked', JSON.stringify({ lat: window.GPS.currentLat, lon: window.GPS.currentLon, time: Date.now() }));
        const toast = document.getElementById('park-toast');
        if (toast) { toast.classList.remove('toast-hidden'); toast.classList.add('toast-visible'); }
        setTimeout(() => { if (toast) { toast.classList.remove('toast-visible'); toast.classList.add('toast-hidden'); } }, 3000);
        if (navigator.vibrate) navigator.vibrate(100);
    }

    // ═══ CAMERA ═════════════════════════════════════════
    async function startCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video:{facingMode:{ideal:'environment'}}, audio:false });
            cameraStream = stream;
            const v = document.getElementById('camera-feed');
            v.srcObject = stream; v.play();
            return true;
        } catch(e) { 
            alert("Camera error: " + e.message + "\nPlease try on HTTPS or check permissions.");
            console.warn("Camera unavailable:", e); 
            return false; 
        }
    }

    // ═══ OBSTACLE DETECTION ═════════════════════════════
    let aiWorker = null;
    
    async function startObstacleDetection() {
        try {
            aiWorker = new Worker('ai-worker.js');
            
            const video = document.getElementById('camera-feed');
            const warnEl = document.getElementById('obstacle-warning');
            const detailEl = document.getElementById('obstacle-detail');
            
            let lastWarn = 0;
            let workerReady = false;
            let isDetecting = false;
            
            const hiddenCanvas = document.createElement('canvas');
            const hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });

            // Color map for bounding boxes (matching reference image)
            const colorMap = {
                'car': { stroke: 'rgba(255,200,0,0.85)', fill: 'rgba(255,200,0,0.12)', label: '#FFD700' },
                'truck': { stroke: 'rgba(255,200,0,0.85)', fill: 'rgba(255,200,0,0.12)', label: '#FFD700' },
                'bus': { stroke: 'rgba(255,200,0,0.85)', fill: 'rgba(255,200,0,0.12)', label: '#FFD700' },
                'motorcycle': { stroke: 'rgba(255,140,0,0.85)', fill: 'rgba(255,140,0,0.1)', label: '#FF8C00' },
                'bicycle': { stroke: 'rgba(0,200,255,0.85)', fill: 'rgba(0,200,255,0.08)', label: '#00C8FF' },
                'person': { stroke: 'rgba(255,60,80,0.9)', fill: 'rgba(255,60,80,0.1)', label: '#FF3C50' },
                'stop sign': { stroke: 'rgba(255,50,50,0.9)', fill: 'rgba(255,50,50,0.12)', label: '#FF3232' },
                'traffic light': { stroke: 'rgba(0,255,100,0.85)', fill: 'rgba(0,255,100,0.08)', label: '#00FF64' },
            };
            const defaultColor = { stroke: 'rgba(0,240,255,0.7)', fill: 'rgba(0,240,255,0.06)', label: '#00F0FF' };

            aiWorker.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    workerReady = true;
                }
                if (e.data.type === 'result') {
                    isDetecting = false;
                    const preds = e.data.preds;
                    
                    const overlayCanvas = document.getElementById('ai-overlay');
                    if (overlayCanvas && video.videoWidth) {
                        overlayCanvas.width = window.innerWidth;
                        overlayCanvas.height = window.innerHeight;
                        const ctx = overlayCanvas.getContext('2d');
                        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                        
                        // Scale from the 224x224 AI processing canvas space to the fullscreen overlay space
                        const scaleX = window.innerWidth / 224;
                        const scaleY = window.innerHeight / 224;

                        preds.forEach(p => {
                            if (p.score < 0.35) return;
                            const colors = colorMap[p.class] || defaultColor;
                            const x = p.bbox[0] * scaleX;
                            const y = p.bbox[1] * scaleY;
                            const w = p.bbox[2] * scaleX;
                            const h = p.bbox[3] * scaleY;
                            
                            ctx.fillStyle = colors.fill;
                            ctx.fillRect(x, y, w, h);
                            
                            ctx.strokeStyle = colors.stroke;
                            ctx.lineWidth = 2.5;
                            ctx.shadowColor = colors.stroke;
                            ctx.shadowBlur = 8;
                            const cl = Math.min(w, h) * 0.25;
                            ctx.beginPath();
                            ctx.moveTo(x, y + cl); ctx.lineTo(x, y); ctx.lineTo(x + cl, y);
                            ctx.moveTo(x + w - cl, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + cl);
                            ctx.moveTo(x + w, y + h - cl); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - cl, y + h);
                            ctx.moveTo(x + cl, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - cl);
                            ctx.stroke();
                            ctx.shadowBlur = 0;
                            
                            const lbl = p.class + ' ' + Math.round(p.score * 100) + '%';
                            ctx.font = "bold 11px 'Outfit',sans-serif";
                            const tw = ctx.measureText(lbl).width;
                            ctx.fillStyle = 'rgba(0,0,0,0.6)';
                            ctx.fillRect(x, y - 18, tw + 8, 17);
                            ctx.fillStyle = colors.label;
                            ctx.fillText(lbl, x + 4, y - 5);
                        });
                    }

                    const dangerous = preds.filter(p => {
                        const isObs = ['car','truck','bus','motorcycle','bicycle','person','stop sign','traffic light'].includes(p.class);
                        // Bounding box size is relative to the downscaled 224x224 processing frame
                        const isClose = p.bbox[2] > 224 * 0.28;
                        const isLarge = p.bbox[3] > 224 * 0.22;
                        return isObs && (isClose || isLarge) && p.score > 0.45;
                    });

                    const now = Date.now();
                    if (dangerous.length > 0 && now - lastWarn > 3000) {
                        lastWarn = now;
                        const obj = dangerous[0];
                        const label = obj.class.charAt(0).toUpperCase() + obj.class.slice(1);
                        if (detailEl) detailEl.innerText = '\u26a0\ufe0f ' + label + ' ahead \u2014 Stay alert!';
                        if (warnEl) { warnEl.classList.remove('obstacle-hidden'); warnEl.classList.add('obstacle-visible'); }
                        if (window.RouteManager && window.RouteManager.audioEnabled) window.RouteManager.speak('Caution: ' + label + ' detected ahead.');
                        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
                        setTimeout(function() { if (warnEl) { warnEl.classList.remove('obstacle-visible'); warnEl.classList.add('obstacle-hidden'); } }, 2500);
                    }
                }
                if (e.data.type === 'error') {
                    isDetecting = false;
                }
            };
            
            isNavigating = true;

            const detectFrame = () => {
                if (!isNavigating) return;
                if (workerReady && !isDetecting && video.videoWidth && !video.paused) {
                    isDetecting = true;
                    try {
                        // Crucial Optimization: Downscale image to 224x224 before GPU analysis to eliminate UI freezing
                        hiddenCanvas.width = 224;
                        hiddenCanvas.height = 224;
                        hiddenCtx.drawImage(video, 0, 0, 224, 224);
                        const imgData = hiddenCtx.getImageData(0, 0, 224, 224);
                        aiWorker.postMessage({ type: 'detect', image: imgData }); 
                    } catch(ex){ isDetecting = false; }
                }
                obstacleInterval = setTimeout(detectFrame, 1200);
            };
            detectFrame();

        } catch(e) { console.warn("AI Worker unavailable:", e); }
    }

    // ═══ START NAVIGATION ═══════════════════════════════
    startBtn.addEventListener('click', async () => {
        const dest = destInput.value.trim();
        if (!dest) { shakeInput(); return; }

        startBtn.disabled = true;
        startBtn.querySelector('.btn-text').style.display='none';
        startBtn.querySelector('.btn-loader').classList.remove('btn-loader-hidden');

        try {
            if (statusText) statusText.innerText="Initializing...";

            // Parallelize Geocode, Camera, and GPS to drastically slash load times
            const geocodePromise = (async () => {
                if (destInput.dataset.lat && destInput.dataset.lon) return { lat: parseFloat(destInput.dataset.lat), lon: parseFloat(destInput.dataset.lon) };
                return await geocode(dest);
            })();

            const cameraPromise = startCamera();
            const gpsPromise = window.GPS.init();

            // Wait for location essentials to grab route
            const [destCoords] = await Promise.all([geocodePromise, gpsPromise]);
            const destLat = destCoords.lat;
            const destLon = destCoords.lon;
            saveRecent(dest, destLat, destLon);
            window.RouteManager.destName = dest;

            // Start route calculation strictly parallel to AR setup
            const routePromise = window.RouteManager.fetchRoute(window.GPS.currentLat, window.GPS.currentLon, destLat, destLon);

            // INSTANT UI STARTUP: Show map and navigation UI extremely fast, don't wait for camera/route to load!
            inputScreen.classList.add('screen-hidden');
            showNav();
            
            // Allow camera to load in background seamlessly
            await cameraPromise;

            window.ARScene.init();

            if (navigator.xr) {
                try {
                    const ok = await navigator.xr.isSessionSupported('immersive-ar');
                    if (ok) {
                        const sess = await navigator.xr.requestSession('immersive-ar', { requiredFeatures:['local-floor','dom-overlay'], domOverlay:{root:document.body} });
                        window.ARScene.renderer.xr.setReferenceSpaceType('local-floor');
                        await window.ARScene.renderer.xr.setSession(sess);
                    }
                } catch(e){}
            }

            let lastCarModeState = null;
            window.GPS.onUpdate((t, d) => {
                if (t==='position' && d.speed!==null) {
                    const isCar = d.speed > 7;
                    if (isCar !== lastCarModeState) {
                        lastCarModeState = isCar;
                        if (isCar) document.body.classList.add('car-mode');
                        else document.body.classList.remove('car-mode');
                    }
                }
            });

            if (statusText) statusText.innerText="Calculating route...";
            await routePromise;

            if (statusText) statusText.innerText="Navigating";
            isNavigating = true;

            // 10. Audio — Auto-enable voice immediately
            window.RouteManager.audioEnabled = true;
            const audioBtn = document.getElementById('enable-audio-btn');
            if (audioBtn) {
                audioBtn.addEventListener('click', () => {
                    window.RouteManager.audioEnabled = !window.RouteManager.audioEnabled;
                    audioBtn.innerText = window.RouteManager.audioEnabled ? '🔊' : '🔇';
                    if (window.RouteManager.audioEnabled) {
                        audioBtn.classList.remove('audio-muted');
                    } else {
                        audioBtn.classList.add('audio-muted');
                    }
                });
            }
            // Announce route start
            try { const u = new SpeechSynthesisUtterance('Navigation started. Voice guidance enabled.'); u.lang='en-US'; u.rate=1; window.speechSynthesis.speak(u); } catch(e) {}

            // 11. Obstacle detection
            startObstacleDetection();

            // 12. Trip stats updater
            startTripUpdater();

            // 13. Wire buttons
            wireButtons();

        } catch(err) {
            console.error(err);
            alert("Navigation failed: " + err.message);
            if (statusText) statusText.innerText="Error: "+err.message;
            inputScreen.classList.remove('screen-hidden');
            resetBtn();
        }
    });

    // ═══ TRIP STATS UPDATER ═════════════════════════════
    let tripInterval = null;
    function startTripUpdater() {
        tripInterval = setInterval(() => {
            if (!isNavigating) return;
            const stats = window.GPS.getTripStats();
            const el = id => document.getElementById(id);
            if (el('trip-distance')) el('trip-distance').innerText = stats.distance;
            if (el('trip-duration')) el('trip-duration').innerText = stats.duration;
            if (el('trip-avg-speed')) el('trip-avg-speed').innerText = stats.avgSpeed;
            if (el('trip-max-speed')) el('trip-max-speed').innerText = stats.maxSpeed;
        }, 2000);
    }

    // ═══ WIRE BUTTONS ═══════════════════════════════════
    function wireButtons() {
        const $ = id => document.getElementById(id);

        // Voice toggle
        $('toggle-voice-btn')?.addEventListener('click', () => {
            window.RouteManager.audioEnabled = !window.RouteManager.audioEnabled;
            const btn = $('toggle-voice-btn');
            if (btn) btn.innerText = window.RouteManager.audioEnabled ? '🔊' : '🔇';
        });

        // Recenter
        $('recenter-btn')?.addEventListener('click', () => {
            if (window.RouteManager.mapInstance && window.GPS.currentLat) {
                window.RouteManager.mapInstance.panTo([window.GPS.currentLat, window.GPS.currentLon]);
                window.RouteManager.mapInstance.setZoom(16);
            }
        });

        // Share location
        $('share-btn')?.addEventListener('click', async () => {
            if (!window.GPS.currentLat) return;
            const url = `https://www.google.com/maps?q=${window.GPS.currentLat},${window.GPS.currentLon}`;
            if (navigator.share) {
                try { await navigator.share({ title:'My Location — AstraNav', text:'Here is my current location:', url }); } catch(e){}
            } else {
                navigator.clipboard.writeText(url);
                showToast('📋 Location copied!');
            }
        });

        // Park here
        $('park-btn')?.addEventListener('click', () => saveParkingSpot());

        // SOS
        $('sos-btn')?.addEventListener('click', () => {
            const modal = $('sos-modal');
            if (modal) { modal.classList.remove('sos-hidden'); modal.classList.add('sos-visible'); }
            if (window.GPS.currentLat) {
                const loc = $('sos-location');
                if (loc) loc.innerText = `Location: ${window.GPS.currentLat.toFixed(6)}, ${window.GPS.currentLon.toFixed(6)}`;
            }
        });

        $('sos-close')?.addEventListener('click', () => {
            const m = $('sos-modal');
            if (m) { m.classList.remove('sos-visible'); m.classList.add('sos-hidden'); }
        });

        $('sos-share')?.addEventListener('click', async () => {
            if (!window.GPS.currentLat) return;
            const url = `https://www.google.com/maps?q=${window.GPS.currentLat},${window.GPS.currentLon}`;
            if (navigator.share) {
                try { await navigator.share({ title:'🆘 EMERGENCY — My Location', text:'I need help! My location:', url }); } catch(e){}
            } else {
                navigator.clipboard.writeText(url);
                showToast('📋 Emergency location copied!');
            }
        });

        // End navigation (double tap top HUD)
        $('top-hud')?.addEventListener('dblclick', () => {
            if (confirm('Exit navigation?')) endNav();
        });

        // Trip dashboard toggle (double tap minimap area)
        $('bottom-right-container')?.addEventListener('dblclick', () => {
            const td = $('trip-dashboard');
            if (td) { td.classList.toggle('trip-hidden'); td.classList.toggle('trip-open'); }
        });

        $('trip-close-btn')?.addEventListener('click', () => {
            const td = $('trip-dashboard');
            if (td) { td.classList.add('trip-hidden'); td.classList.remove('trip-open'); }
        });
    }

    // ═══ SHOW/HIDE NAV ══════════════════════════════════
    function showNav() {
        ['top-hud','bottom-right-container','bottom-left-container','map-options'].forEach(id => {
            const e = document.getElementById(id); if (e) { e.classList.remove('nav-hidden'); e.classList.add('nav-visible'); }
        });
    }

    function hideNav() {
        ['top-hud','bottom-right-container','bottom-left-container','map-options','enable-audio-btn'].forEach(id => {
            const e = document.getElementById(id); if (e) { e.classList.remove('nav-visible'); e.classList.add('nav-hidden'); }
        });
        const c=document.getElementById('central-hud'); if(c){c.classList.remove('central-visible');c.classList.add('central-hidden');}
        const mw=document.getElementById('minimap-wrapper'); if(mw){mw.classList.remove('nav-visible');mw.classList.add('nav-hidden');}
        const lg=document.getElementById('lane-guidance'); if(lg) lg.classList.add('lane-hidden');
        const fm=document.getElementById('fullscreen-map-overlay'); if(fm){fm.classList.remove('fullmap-open');fm.classList.add('fullmap-closed');}
        const ap=document.getElementById('route-alternatives-panel'); if(ap) ap.classList.add('alt-hidden');
        const wb=document.getElementById('weather-banner'); if(wb){wb.classList.remove('weather-visible');wb.classList.add('weather-hidden');}
        const sw=document.getElementById('speed-warning'); if(sw){sw.classList.remove('speed-warn-visible');sw.classList.add('speed-warn-hidden');}
        const rq=document.getElementById('road-quality'); if(rq){rq.classList.remove('rq-visible');rq.classList.add('rq-hidden');}
        const td=document.getElementById('trip-dashboard'); if(td){td.classList.add('trip-hidden');td.classList.remove('trip-open');}
    }

    // ═══ END NAVIGATION ═════════════════════════════════
    function endNav() {
        isNavigating = false;
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        if (obstacleInterval) { clearTimeout(obstacleInterval); obstacleInterval=null; }
        if (aiWorker) { aiWorker.terminate(); aiWorker=null; }
        if (tripInterval) { clearInterval(tripInterval); tripInterval=null; }
        if (cameraStream) { cameraStream.getTracks().forEach(t=>t.stop()); cameraStream=null; }
        const v=document.getElementById('camera-feed'); if(v) v.srcObject=null;

        window.GPS.destroy();
        window.RouteManager.destroy();

        hideNav();
        document.body.classList.remove('car-mode');
        document.getElementById('ar-container').innerHTML='';

        const ow=document.getElementById('obstacle-warning'); if(ow){ow.classList.remove('obstacle-visible');ow.classList.add('obstacle-hidden');}
        const sm=document.getElementById('sos-modal'); if(sm){sm.classList.remove('sos-visible');sm.classList.add('sos-hidden');}

        inputScreen.classList.remove('screen-hidden');
        resetBtn();
        destInput.value=''; delete destInput.dataset.lat; delete destInput.dataset.lon;
        loadRecent();
        loadParkedCar();
    }

    // ═══ UTILITIES ══════════════════════════════════════
    async function geocode(addr) {
        try { const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addr)}&limit=1`);const d=await r.json();if(d?.length)return{lat:parseFloat(d[0].lat),lon:parseFloat(d[0].lon)}; } catch(e){}
        try { const r=await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(addr)}&limit=1`);const d=await r.json();if(d.features?.length){const c=d.features[0].geometry.coordinates;return{lat:c[1],lon:c[0]};} } catch(e){}
        throw new Error("Location not found.");
    }

    function resetBtn() {
        startBtn.disabled=false;
        const bt=startBtn.querySelector('.btn-text'),bl=startBtn.querySelector('.btn-loader');
        if(bt) bt.style.display=''; if(bl) bl.classList.add('btn-loader-hidden');
    }

    function shakeInput() {
        const w=destInput.closest('.search-wrapper');
        w.style.animation='shake .4s ease'; w.style.borderColor='#ff4444';
        setTimeout(()=>{ w.style.animation=''; w.style.borderColor=''; }, 500);
    }

    function showToast(msg) {
        const t=document.getElementById('park-toast');
        if(t){ t.innerText=msg; t.classList.remove('toast-hidden'); t.classList.add('toast-visible'); }
        setTimeout(()=>{ if(t){ t.classList.remove('toast-visible'); t.classList.add('toast-hidden'); } }, 3000);
    }

    // ═══ CLOCK + SPEED LOOP ═══════════════════════════════
    setInterval(() => {
        const d = new Date();
        let h = d.getHours(), m = d.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        const el = document.getElementById('top-time');
        if (el) el.innerText = `${h}:${m.toString().padStart(2, '0')} ${ampm}`;

        // Speed display
        const sv = document.getElementById('speed-value');
        if (sv && window.GPS && window.GPS.speed !== undefined) {
            sv.innerText = Math.round(window.GPS.speed * 3.6);
        }
    }, 500);
});
