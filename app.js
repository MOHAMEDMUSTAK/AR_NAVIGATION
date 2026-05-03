// app.js — AstraNav Orchestrator v5
// FIXES: Camera 720p (faster start), parallel init, speed via rAF, clean endNav with AR reset

const initApp = () => {
    if (window.astranav_initialized) return;
    window.astranav_initialized = true;

    const startBtn       = document.getElementById('start-btn');
    const inputScreen    = document.getElementById('input-screen');
    const destInput      = document.getElementById('dest-address');
    const suggestionsPanel = document.getElementById('search-suggestions');

    let isNavigating = false, searchTimeout = null;
    let aiWorker = null, obstacleTimer = null, cameraStream = null;

    // Day/Night — system pref takes priority, fallback to time
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const h = new Date().getHours();
    if (prefersDark || h < 6 || h >= 19) document.body.classList.add('night-mode');

    loadRecent();
    loadParkedCar();

    // ═══ TRAVEL MODE ═══════════════════════════════════════
    const modeButtons = document.querySelectorAll('.mode-btn');
    let selectedMode = 'driving';
    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            modeButtons.forEach(b => b.classList.remove('mode-active'));
            btn.classList.add('mode-active');
            selectedMode = btn.dataset.mode;
            if (navigator.vibrate) navigator.vibrate(30);
        });
    });

    // ═══ SEARCH AUTOCOMPLETE ════════════════════════════════
    destInput.addEventListener('input', () => {
        if (window.GPS && !window.GPS.active) window.GPS.init().catch(() => {});
        const q = destInput.value.trim();
        if (searchTimeout) clearTimeout(searchTimeout);
        if (q.length < 3) { suggestionsPanel.classList.add('suggestions-hidden'); return; }
        searchTimeout = setTimeout(() => fetchSuggestions(q), 280);
    });

    destInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { suggestionsPanel.classList.add('suggestions-hidden'); startBtn.click(); }
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('.input-group')) suggestionsPanel.classList.add('suggestions-hidden');
    });

    async function fetchSuggestions(q) {
        try {
            const r = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&addressdetails=1`,
                { headers: { 'Accept-Language': 'en' } }
            );
            const d = await r.json();
            if (d?.length) { showSuggestions(d); return; }
        } catch (e) {}
        try {
            const pr = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`);
            const pd = await pr.json();
            if (pd.features?.length) {
                showSuggestions(pd.features.map(f => ({
                    display_name: f.properties.name + (f.properties.city ? `, ${f.properties.city}` : '') + (f.properties.country ? `, ${f.properties.country}` : ''),
                    lat: f.geometry.coordinates[1],
                    lon: f.geometry.coordinates[0]
                })));
            }
        } catch (e) {}
    }

    function showSuggestions(results) {
        suggestionsPanel.innerHTML = '';
        suggestionsPanel.classList.remove('suggestions-hidden');
        results.forEach(r => {
            const it = document.createElement('div');
            it.className = 'suggestion-item';
            const nm = r.display_name.split(',')[0];
            const dt = r.display_name.split(',').slice(1, 3).join(',').trim();
            it.innerHTML = `<div class="suggestion-name">${nm}</div><div class="suggestion-detail">${dt}</div>`;
            it.addEventListener('click', () => {
                destInput.value = r.display_name;
                destInput.dataset.lat = r.lat;
                destInput.dataset.lon = r.lon;
                suggestionsPanel.classList.add('suggestions-hidden');
            });
            suggestionsPanel.appendChild(it);
        });
    }

    // ═══ VOICE INPUT ════════════════════════════════════════
    const voiceInputBtn = document.getElementById('voice-input-btn');
    if (voiceInputBtn && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
        voiceInputBtn.addEventListener('click', () => {
            const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
            const rec = new SR();
            rec.lang = 'en-US';
            rec.interimResults = false;
            rec.maxAlternatives = 1;
            voiceInputBtn.classList.add('listening');
            rec.onresult = e => {
                destInput.value = e.results[0][0].transcript;
                voiceInputBtn.classList.remove('listening');
                fetchSuggestions(destInput.value);
            };
            rec.onerror = rec.onend = () => voiceInputBtn.classList.remove('listening');
            rec.start();
        });
    } else if (voiceInputBtn) {
        voiceInputBtn.style.display = 'none';
    }

    // ═══ RECENT DESTINATIONS ════════════════════════════════
    function loadRecent() {
        try {
            const rec = JSON.parse(localStorage.getItem('astranav_recent') || '[]');
            if (!rec.length) return;
            const sec = document.getElementById('recent-destinations');
            const list = document.getElementById('recent-list');
            sec.classList.remove('recent-hidden');
            list.innerHTML = '';
            rec.slice(0, 5).forEach(d => {
                const it = document.createElement('div');
                it.className = 'recent-item';
                it.innerText = d.name.length > 38 ? d.name.substring(0, 38) + '…' : d.name;
                it.addEventListener('click', () => {
                    destInput.value = d.name;
                    destInput.dataset.lat = d.lat;
                    destInput.dataset.lon = d.lon;
                });
                list.appendChild(it);
            });
        } catch (e) {}
    }

    function saveRecent(name, lat, lon) {
        try {
            let r = JSON.parse(localStorage.getItem('astranav_recent') || '[]');
            r = r.filter(d => d.name !== name);
            r.unshift({ name, lat, lon });
            localStorage.setItem('astranav_recent', JSON.stringify(r.slice(0, 5)));
        } catch (e) {}
    }

    // ═══ PARKED CAR ═════════════════════════════════════════
    function loadParkedCar() {
        try {
            const p = JSON.parse(localStorage.getItem('astranav_parked'));
            if (p) {
                document.getElementById('parked-car').classList.remove('parked-hidden');
                document.getElementById('go-to-car-btn').addEventListener('click', () => {
                    destInput.value = 'My Parked Car';
                    destInput.dataset.lat = p.lat;
                    destInput.dataset.lon = p.lon;
                    startBtn.click();
                });
            }
        } catch (e) {}
    }

    function saveParkingSpot() {
        if (!window.GPS.currentLat) return;
        localStorage.setItem('astranav_parked', JSON.stringify({
            lat: window.GPS.currentLat,
            lon: window.GPS.currentLon,
            time: Date.now()
        }));
        showToast('📍 Parking spot saved!');
        if (navigator.vibrate) navigator.vibrate(100);
    }

    // ═══ CAMERA — 720p for instant start ════════════════════
    async function startCamera() {
        const constraints = [
            // Option 1: 720p rear camera (fast on mobile)
            { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
            // Option 2: Any rear camera
            { video: { facingMode: { ideal: 'environment' } }, audio: false },
            // Option 3: Any camera (last resort)
            { video: true, audio: false }
        ];

        for (const c of constraints) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia(c);
                cameraStream = stream;
                const v = document.getElementById('camera-feed');
                v.srcObject = stream;
                await v.play();
                return true;
            } catch (e) { /* try next */ }
        }
        console.warn('Camera unavailable.');
        return false;
    }

    // ═══ OBSTACLE DETECTION (DEFERRED 6s) ═══════════════════
    function startObstacleDetection() {
        setTimeout(() => {
            // Skip AI on low-end devices
            const cores = navigator.hardwareConcurrency || 2;
            if (cores < 3) { console.log('AI skipped: low-end device'); return; }
            try {
                aiWorker = new Worker('ai-worker.js');
                const video = document.getElementById('camera-feed');
                const warnEl = document.getElementById('obstacle-warning');
                const detailEl = document.getElementById('obstacle-detail');
                let lastWarn = 0, workerReady = false, isDetecting = false;

                const hiddenCanvas = document.createElement('canvas');
                hiddenCanvas.width = 224; hiddenCanvas.height = 224;
                const hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });

                const colorMap = {
                    'car':          { stroke: '#FFD700', fill: 'rgba(255,215,0,0.12)' },
                    'truck':        { stroke: '#FFD700', fill: 'rgba(255,215,0,0.12)' },
                    'bus':          { stroke: '#FFD700', fill: 'rgba(255,215,0,0.12)' },
                    'motorcycle':   { stroke: '#FF8C00', fill: 'rgba(255,140,0,0.10)' },
                    'bicycle':      { stroke: '#00E5FF', fill: 'rgba(0,229,255,0.09)' },
                    'person':       { stroke: '#FF3C50', fill: 'rgba(255,60,80,0.10)' },
                    'stop sign':    { stroke: '#FF3232', fill: 'rgba(255,50,50,0.12)' },
                    'traffic light':{ stroke: '#00FF64', fill: 'rgba(0,255,100,0.09)' },
                };
                const defaultColor = { stroke: '#00E5FF', fill: 'rgba(0,229,255,0.07)' };

                aiWorker.onmessage = e => {
                    if (e.data.type === 'ready') { workerReady = true; }
                    if (e.data.type === 'result') {
                        isDetecting = false;
                        const preds = e.data.preds;
                        const overlayCanvas = document.getElementById('ai-overlay');
                        if (overlayCanvas && video.videoWidth) {
                            overlayCanvas.width = window.innerWidth;
                            overlayCanvas.height = window.innerHeight;
                            const ctx = overlayCanvas.getContext('2d');
                            ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                            const sx = window.innerWidth / 224, sy = window.innerHeight / 224;
                            preds.forEach(p => {
                                if (p.score < 0.35) return;
                                const colors = colorMap[p.class] || defaultColor;
                                const x = p.bbox[0] * sx, y = p.bbox[1] * sy;
                                const w = p.bbox[2] * sx, bh = p.bbox[3] * sy;
                                ctx.fillStyle = colors.fill; ctx.fillRect(x, y, w, bh);
                                ctx.strokeStyle = colors.stroke;
                                ctx.lineWidth = 2; ctx.shadowColor = colors.stroke; ctx.shadowBlur = 5;
                                const cl = Math.min(w, bh) * 0.22;
                                ctx.beginPath();
                                ctx.moveTo(x, y+cl); ctx.lineTo(x, y); ctx.lineTo(x+cl, y);
                                ctx.moveTo(x+w-cl, y); ctx.lineTo(x+w, y); ctx.lineTo(x+w, y+cl);
                                ctx.moveTo(x+w, y+bh-cl); ctx.lineTo(x+w, y+bh); ctx.lineTo(x+w-cl, y+bh);
                                ctx.moveTo(x+cl, y+bh); ctx.lineTo(x, y+bh); ctx.lineTo(x, y+bh-cl);
                                ctx.stroke(); ctx.shadowBlur = 0;
                                ctx.font = "bold 10px 'Outfit',sans-serif";
                                const lbl = p.class + ' ' + Math.round(p.score * 100) + '%';
                                const tw = ctx.measureText(lbl).width;
                                ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x, y-17, tw+7, 16);
                                ctx.fillStyle = colors.stroke; ctx.fillText(lbl, x+3, y-5);
                            });
                        }
                        const dangerous = preds.filter(p =>
                            ['car','truck','bus','motorcycle','bicycle','person','stop sign','traffic light'].includes(p.class)
                            && (p.bbox[2] > 224*0.28 || p.bbox[3] > 224*0.22) && p.score > 0.45
                        );
                        const now = Date.now();
                        if (dangerous.length > 0 && now - lastWarn > 4500) {
                            lastWarn = now;
                            const obj = dangerous[0];
                            const label = obj.class.charAt(0).toUpperCase() + obj.class.slice(1);
                            if (detailEl) detailEl.innerText = `⚠️ ${label} ahead — Stay alert!`;
                            if (warnEl) { warnEl.classList.remove('obstacle-hidden'); warnEl.classList.add('obstacle-visible'); }
                            if (window.RouteManager?.audioEnabled) window.RouteManager.speak('Caution: ' + label + ' detected ahead.');
                            if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
                            setTimeout(() => { if (warnEl) { warnEl.classList.remove('obstacle-visible'); warnEl.classList.add('obstacle-hidden'); } }, 2800);
                        }
                    }
                    if (e.data.type === 'error') isDetecting = false;
                };

                const detectFrame = () => {
                    if (!isNavigating) return;
                    if (workerReady && !isDetecting && video.videoWidth && !video.paused) {
                        isDetecting = true;
                        try {
                            hiddenCtx.drawImage(video, 0, 0, 224, 224);
                            const imgData = hiddenCtx.getImageData(0, 0, 224, 224);
                            aiWorker.postMessage({ type: 'detect', image: imgData });
                        } catch (ex) { isDetecting = false; }
                    }
                    obstacleTimer = setTimeout(detectFrame, 4000); // Detect every 4s
                };
                detectFrame();
            } catch (e) { console.warn('AI Worker unavailable:', e); }
        }, 10000);
    }

    // ═══ START NAVIGATION ════════════════════════════════════
    startBtn.addEventListener('click', async () => {
        const dest = destInput.value.trim();
        if (!dest) { shakeInput(); return; }

        startBtn.disabled = true;
        startBtn.querySelector('.btn-text').style.display = 'none';
        startBtn.querySelector('.btn-loader').classList.remove('btn-loader-hidden');

        try {
            window.RouteManager.travelMode = selectedMode;

            // ALL three start in parallel — fastest possible init
            const geocodePromise = (async () => {
                if (destInput.dataset.lat && destInput.dataset.lon) {
                    return { lat: parseFloat(destInput.dataset.lat), lon: parseFloat(destInput.dataset.lon) };
                }
                return await geocode(dest);
            })();
            const cameraPromise = startCamera();
            const gpsPromise = window.GPS.init();

            // GPS and geocode in parallel
            const [destCoords] = await Promise.all([geocodePromise, gpsPromise]);
            const destLat = destCoords.lat;
            const destLon = destCoords.lon;
            saveRecent(dest, destLat, destLon);

            window.RouteManager.destName = dest.split(',').slice(0, 2).join(', ');
            const hName = document.getElementById('dest-name-hud');
            if (hName) hName.innerText = window.RouteManager.destName;

            // Show nav UI immediately — don't wait for route or camera
            inputScreen.classList.add('screen-hidden');
            showNav();

            // Route + camera in parallel
            const routePromise = window.RouteManager.fetchRoute(
                window.GPS.currentLat, window.GPS.currentLon, destLat, destLon
            );

            await cameraPromise;

            // Init AR AFTER camera is ready
            window.ARScene.init();

            // Try WebXR for true AR (optional — degrades gracefully)
            if (navigator.xr) {
                try {
                    const ok = await navigator.xr.isSessionSupported('immersive-ar');
                    if (ok) {
                        const sess = await navigator.xr.requestSession('immersive-ar', {
                            requiredFeatures: ['local-floor', 'dom-overlay'],
                            domOverlay: { root: document.body }
                        });
                        window.ARScene.renderer.xr.setReferenceSpaceType('local-floor');
                        await window.ARScene.renderer.xr.setSession(sess);
                    }
                } catch (e) {}
            }

            // Auto car-mode detection (bigger UI elements at driving speed)
            let lastCarMode = null;
            window.GPS.onUpdate((t, d) => {
                if (t === 'position' && d.speed !== null) {
                    const isCar = d.speed > 6;
                    if (isCar !== lastCarMode) {
                        lastCarMode = isCar;
                        document.body.classList.toggle('car-mode', isCar);
                    }
                }
            });

            await routePromise;
            isNavigating = true;

            // Audio — auto-enable
            window.RouteManager.audioEnabled = true;

            const audioBtn = document.getElementById('enable-audio-btn');
            if (audioBtn) {
                audioBtn.addEventListener('click', () => {
                    window.RouteManager.audioEnabled = !window.RouteManager.audioEnabled;
                    audioBtn.innerText = window.RouteManager.audioEnabled ? '🔊' : '🔇';
                    audioBtn.classList.toggle('audio-muted', !window.RouteManager.audioEnabled);
                });
            }

            // Announce start
            const modeText = selectedMode === 'walking' ? 'Walking' : selectedMode === 'cycling' ? 'Cycling' : 'Driving';
            try {
                const u = new SpeechSynthesisUtterance(`${modeText} navigation started.`);
                u.lang = 'en-US'; u.rate = 1.0;
                window.speechSynthesis.speak(u);
            } catch (e) {}

            startObstacleDetection();
            startTripUpdater();
            wireButtons();

        } catch (err) {
            console.error(err);
            alert('Navigation failed: ' + err.message);
            inputScreen.classList.remove('screen-hidden');
            resetBtn();
        }
    });

    // ═══ TRIP STATS ═════════════════════════════════════════
    let tripInterval = null;
    function startTripUpdater() {
        tripInterval = setInterval(() => {
            if (!isNavigating) return;
            const stats = window.GPS.getTripStats();
            const $ = id => document.getElementById(id);
            if ($('trip-distance')) $('trip-distance').innerText = stats.distance;
            if ($('trip-duration')) $('trip-duration').innerText = stats.duration;
            if ($('trip-avg-speed')) $('trip-avg-speed').innerText = stats.avgSpeed;
            if ($('trip-max-speed')) $('trip-max-speed').innerText = stats.maxSpeed;
        }, 2000);
    }

    // ═══ BUTTONS ════════════════════════════════════════════
    function wireButtons() {
        const $ = id => document.getElementById(id);

        $('toggle-voice-btn')?.addEventListener('click', () => {
            window.RouteManager.audioEnabled = !window.RouteManager.audioEnabled;
            const btn = $('toggle-voice-btn');
            if (btn) btn.innerText = window.RouteManager.audioEnabled ? '🔊' : '🔇';
        });

        $('recenter-btn')?.addEventListener('click', () => {
            if (window.RouteManager.mapInstance && window.GPS.currentLat) {
                window.RouteManager.mapInstance.panTo([window.GPS.currentLat, window.GPS.currentLon]);
                window.RouteManager.mapInstance.setZoom(17);
            }
        });

        $('share-btn')?.addEventListener('click', async () => {
            if (!window.GPS.currentLat) return;
            const url = `https://www.google.com/maps?q=${window.GPS.currentLat},${window.GPS.currentLon}`;
            if (navigator.share) {
                try { await navigator.share({ title: 'My Location — AstraNav', text: 'My current location:', url }); } catch (e) {}
            } else {
                navigator.clipboard?.writeText(url);
                showToast('📋 Location copied!');
            }
        });

        $('park-btn')?.addEventListener('click', () => saveParkingSpot());

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
                try { await navigator.share({ title: '🆘 EMERGENCY', text: 'I need help! My location:', url }); } catch (e) {}
            } else {
                navigator.clipboard?.writeText(url);
                showToast('📋 Emergency location copied!');
            }
        });

        $('top-hud')?.addEventListener('dblclick', () => {
            if (confirm('Exit navigation?')) endNav();
        });

        $('bottom-right-container')?.addEventListener('dblclick', () => {
            const td = $('trip-dashboard');
            if (td) { td.classList.toggle('trip-hidden'); td.classList.toggle('trip-open'); }
        });

        $('trip-close-btn')?.addEventListener('click', () => {
            const td = $('trip-dashboard');
            if (td) { td.classList.add('trip-hidden'); td.classList.remove('trip-open'); }
        });
    }

    // ═══ SHOW NAV ════════════════════════════════════════════
    function showNav() {
        ['top-hud', 'bottom-right-container', 'bottom-left-container', 'map-options', 'compass-widget'].forEach(id => {
            const e = document.getElementById(id);
            if (e) { e.classList.remove('nav-hidden'); e.classList.add('nav-visible'); }
        });
    }

    function hideNav() {
        ['top-hud', 'bottom-right-container', 'bottom-left-container', 'map-options', 'enable-audio-btn', 'compass-widget'].forEach(id => {
            const e = document.getElementById(id);
            if (e) { e.classList.remove('nav-visible'); e.classList.add('nav-hidden'); }
        });
        ['minimap-wrapper', 'lane-guidance', 'weather-banner', 'speed-warning', 'road-quality', 'trip-dashboard']
            .forEach(id => {
                const e = document.getElementById(id);
                if (!e) return;
                if (id === 'minimap-wrapper') { e.classList.remove('nav-visible'); e.classList.add('nav-hidden'); }
                else if (id === 'lane-guidance') e.classList.add('lane-hidden');
                else if (id === 'weather-banner') { e.classList.remove('weather-visible'); e.classList.add('weather-hidden'); }
                else if (id === 'speed-warning') { e.classList.remove('speed-warn-visible'); e.classList.add('speed-warn-hidden'); }
                else if (id === 'road-quality') { e.classList.remove('rq-visible'); e.classList.add('rq-hidden'); }
                else if (id === 'trip-dashboard') { e.classList.add('trip-hidden'); e.classList.remove('trip-open'); }
            });
        const fm = document.getElementById('fullscreen-map-overlay');
        if (fm) { fm.classList.remove('fullmap-open'); fm.classList.add('fullmap-closed'); }
        const ap = document.getElementById('route-alternatives-panel');
        if (ap) ap.classList.add('alt-hidden');
    }

    // ═══ END NAVIGATION ═════════════════════════════════════
    function endNav() {
        isNavigating = false;
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        if (obstacleTimer) { clearTimeout(obstacleTimer); obstacleTimer = null; }
        if (aiWorker) { aiWorker.terminate(); aiWorker = null; }
        if (tripInterval) { clearInterval(tripInterval); tripInterval = null; }
        if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
        const v = document.getElementById('camera-feed'); if (v) v.srcObject = null;

        // Clear AR scene
        if (window.ARScene?.renderer) {
            window.ARScene.renderer.setAnimationLoop(null);
        }

        window.GPS.destroy();
        window.RouteManager.destroy(); // resetAnchor called inside

        hideNav();
        document.body.classList.remove('car-mode', 'night-mode');

        // Re-apply day/night
        const hr = new Date().getHours();
        const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        if (dark || hr < 6 || hr >= 19) document.body.classList.add('night-mode');

        const arContainer = document.getElementById('ar-container');
        if (arContainer) arContainer.innerHTML = '';

        const aiOverlay = document.getElementById('ai-overlay');
        if (aiOverlay) { const ctx = aiOverlay.getContext('2d'); ctx?.clearRect(0, 0, aiOverlay.width, aiOverlay.height); }

        ['obstacle-warning', 'sos-modal'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.className = id === 'obstacle-warning' ? 'obstacle-hidden' : 'sos-hidden';
            }
        });

        inputScreen.classList.remove('screen-hidden');
        resetBtn();
        destInput.value = '';
        delete destInput.dataset.lat;
        delete destInput.dataset.lon;
        window.astranav_initialized = false; // Allow re-init on next start
        loadRecent();
        loadParkedCar();
    }

    // ═══ UTILITIES ══════════════════════════════════════════
    async function geocode(addr) {
        try {
            const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addr)}&limit=1`);
            const d = await r.json();
            if (d?.length) return { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) };
        } catch (e) {}
        try {
            const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(addr)}&limit=1`);
            const d = await r.json();
            if (d.features?.length) { const c = d.features[0].geometry.coordinates; return { lat: c[1], lon: c[0] }; }
        } catch (e) {}
        throw new Error('Location not found.');
    }

    function resetBtn() {
        startBtn.disabled = false;
        const bt = startBtn.querySelector('.btn-text');
        const bl = startBtn.querySelector('.btn-loader');
        if (bt) bt.style.display = '';
        if (bl) bl.classList.add('btn-loader-hidden');
    }

    function shakeInput() {
        const w = destInput.closest('.search-wrapper');
        if (!w) return;
        w.style.animation = 'shake .4s ease';
        w.style.borderColor = '#ff4444';
        setTimeout(() => { w.style.animation = ''; w.style.borderColor = ''; }, 500);
    }

    function showToast(msg) {
        const t = document.getElementById('park-toast');
        if (t) {
            t.innerText = msg;
            t.classList.remove('toast-hidden');
            t.classList.add('toast-visible');
            setTimeout(() => { t.classList.remove('toast-visible'); t.classList.add('toast-hidden'); }, 3000);
        }
    }

    // ═══ CLOCK at 1fps + SPEED at 10fps — no need for 60fps ══════════
    let lastClockUpdate = 0;
    let lastSpeedUpdate = 0;
    function clockLoop(ts) {
        // Clock once per second
        if (ts - lastClockUpdate >= 1000) {
            lastClockUpdate = ts;
            const d = new Date();
            let hr = d.getHours(), mi = d.getMinutes();
            const ampm = hr >= 12 ? 'PM' : 'AM';
            hr = hr % 12 || 12;
            const topTime = document.getElementById('top-time');
            if (topTime) topTime.innerText = `${hr}:${mi.toString().padStart(2, '0')} ${ampm}`;
        }
        // Speed at 10fps
        if (ts - lastSpeedUpdate >= 100) {
            lastSpeedUpdate = ts;
            const sv = document.getElementById('speed-value');
            if (sv && window.GPS && window.GPS.speed !== undefined) {
                sv.innerText = Math.round(window.GPS.speed * 3.6);
            }
        }
        requestAnimationFrame(clockLoop);
    }
    requestAnimationFrame(clockLoop);
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
