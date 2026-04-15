// ar.js — PrecisionAR v4
// FIXES: Arrow placement (user-centered origin), performance, continuous path updates

window.ARScene = {
    scene: null, camera: null, renderer: null,
    pathGroup: new THREE.Group(),
    chevronMat: null,
    xrActive: false, initialHeading: null,
    lastBuildTime: 0,

    init() {
        const c = document.getElementById('ar-container');
        if (!c) return;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 800);

        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false }); // antialias OFF for mobile performance
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(1.0); // Lock to 1.0 for max performance on mobile
        this.renderer.xr.enabled = true;
        c.appendChild(this.renderer.domElement);

        // Minimal lighting
        this.scene.add(new THREE.AmbientLight(0xffffff, 1.0));

        this.scene.add(this.pathGroup);
        this.createChevron();

        // Compass-driven camera for non-WebXR
        window.GPS.onUpdate((t, v) => {
            if (t === 'heading' && !this.xrActive) {
                this.camera.rotation.y = THREE.MathUtils.degToRad(-v);
                this.camera.rotation.order = "YXZ";
            }
        });

        this.renderer.xr.addEventListener('sessionstart', () => {
            this.xrActive = true;
            this.initialHeading = window.GPS.smoothHeading;
        });
        this.renderer.xr.addEventListener('sessionend', () => { this.xrActive = false; });

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });

        this.renderer.setAnimationLoop(this.animate.bind(this));
    },

    createChevron() {
        const cv = document.createElement('canvas');
        cv.width = 128; cv.height = 128; // Smaller texture for performance
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, 128, 128);

        // Bold neon chevron
        ctx.lineCap = 'round';
        ctx.lineJoin = 'miter';
        ctx.miterLimit = 2;

        // Outer glow
        ctx.shadowColor = '#00f0ff';
        ctx.shadowBlur = 15;
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 20;

        ctx.beginPath();
        ctx.moveTo(15, 95);
        ctx.lineTo(64, 35);
        ctx.lineTo(113, 95);
        ctx.stroke();

        // White core
        ctx.shadowBlur = 6;
        ctx.shadowColor = '#ffffff';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 8;

        ctx.beginPath();
        ctx.moveTo(15, 95);
        ctx.lineTo(64, 35);
        ctx.lineTo(113, 95);
        ctx.stroke();

        const tex = new THREE.CanvasTexture(cv);
        this.chevronMat = new THREE.MeshBasicMaterial({
            map: tex, color: 0xffffff,
            transparent: true, opacity: 0.92, side: THREE.DoubleSide,
            depthWrite: false
        });
    },

    buildPath() {
        if (!window.RouteManager || window.RouteManager.pathCoordinates.length < 2) return;

        // Throttle rebuilds to max 5/sec
        const now = Date.now();
        if (now - this.lastBuildTime < 200) return;
        this.lastBuildTime = now;

        // Clear old geometry
        while (this.pathGroup.children.length) {
            const ch = this.pathGroup.children[0];
            if (ch.traverse) ch.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== this.chevronMat) o.material.dispose(); });
            this.pathGroup.remove(ch);
        }

        this.pathGroup.position.set(0, 0, 0);
        this.pathGroup.rotation.set(0, 0, 0);
        
        if (this.xrActive && this.initialHeading !== null) {
            this.pathGroup.rotation.y = THREE.MathUtils.degToRad(-this.initialHeading);
        }

        // ═══════════════════════════════════════════════════
        // PATH BUILDING — User-centered coordinates
        // latLonToLocal() now uses current GPS as origin (0,0)
        // So all coordinates are small relative offsets = no float overflow
        // ═══════════════════════════════════════════════════
        const pts = [];
        const srCtx = window.RouteManager.lastSnapIndex || 0;
        const curCoords = window.RouteManager.pathCoordinates;

        // Start from the OSRM path at the snapped index
        let pathDist = 0;
        const maxDist = 180; // Render 180m ahead (not 250 — denser chevrons)

        for (let i = srCtx; i < curCoords.length; i++) {
            const l = window.RouteManager.latLonToLocal(curCoords[i].lat, curCoords[i].lon);
            const v = new THREE.Vector3(l.x, 0.05, l.z);
            
            if (pts.length > 0) {
                pathDist += pts[pts.length - 1].distanceTo(v);
            }
            
            // Skip duplicate/too-close points
            if (pts.length === 0 || pts[pts.length - 1].distanceTo(v) > 0.5) {
                pts.push(v);
            }
            
            if (pathDist > maxDist) break;
        }

        if (pts.length >= 2) {
            const curve = new THREE.CatmullRomCurve3(pts);
            const pathLen = curve.getLength();

            // Dense chevrons every ~2m
            const arrowCount = Math.max(10, Math.min(80, Math.floor(pathLen / 2)));
            const arrowGeo = new THREE.PlaneGeometry(3.5, 3.5);
            arrowGeo.rotateX(-Math.PI / 2); // Flat on ground

            const arrowGroup = new THREE.Group();
            for (let i = 1; i < arrowCount; i++) {
                const u = i / arrowCount;
                const pt = curve.getPoint(u);
                const tangent = curve.getTangent(u);

                const mesh = new THREE.Mesh(arrowGeo, this.chevronMat);
                mesh.position.copy(pt);
                mesh.position.y = 0.05;

                const target = pt.clone().add(tangent);
                mesh.lookAt(target);

                mesh.userData.u = u;
                arrowGroup.add(mesh);
            }
            arrowGroup.userData.isChevronGroup = true;
            arrowGroup.userData.curve = curve;
            this.pathGroup.add(arrowGroup);

            // Lane border lines (green glow)
            const segs = Math.max(15, Math.min(60, Math.floor(pathLen / 2)));
            const frames = curve.computeFrenetFrames(segs, false);
            const leftPts = [], rightPts = [];
            for (let i = 0; i <= segs; i++) {
                const pt = curve.getPoint(i / segs);
                const pL = new THREE.Vector3().copy(pt).addScaledVector(frames.binormals[i], 2.0);
                const pR = new THREE.Vector3().copy(pt).addScaledVector(frames.binormals[i], -2.0);
                leftPts.push(pL); rightPts.push(pR);
            }
            const lineMat = new THREE.LineBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.7 });
            const lineL = new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts), lineMat);
            const lineR = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts), lineMat);
            lineL.position.y = 0.06; lineR.position.y = 0.06;
            this.pathGroup.add(lineL);
            this.pathGroup.add(lineR);
        }

        // 3D Turn Arrows for upcoming turns
        const steps = window.RouteManager.steps;
        const cur = window.RouteManager.currentStepIndex;

        for (let i = cur; i < Math.min(cur + 4, steps.length); i++) {
            const step = steps[i];
            if (!step.maneuver?.location) continue;
            const loc = step.maneuver.location;
            const mod = step.maneuver.modifier || 'straight';
            const lp = window.RouteManager.latLonToLocal(loc[1], loc[0]);
            const d = Math.sqrt(lp.x ** 2 + lp.z ** 2);
            if (d < 200 && mod !== 'straight') this.make3DArrow(lp, mod, i === cur);
        }

        // Destination pin
        if (window.RouteManager.destLat) {
            const dp = window.RouteManager.latLonToLocal(window.RouteManager.destLat, window.RouteManager.destLon);
            if (Math.sqrt(dp.x ** 2 + dp.z ** 2) < 500) this.makeDestPin(dp);
        }
    },

    // ── 3D TURN ARROW ──
    make3DArrow(pos, mod, isNext) {
        const g = new THREE.Group();
        const col = isNext ? 0x00f0ff : 0xb000ff;

        // Vertical beam
        const beamGeo = new THREE.CylinderGeometry(1.2, 0.3, 10, 12, 1, true);
        beamGeo.translate(0, 5, 0);
        const beamMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false });
        g.add(new THREE.Mesh(beamGeo, beamMat));

        // Floating sign
        const signGroup = new THREE.Group();
        signGroup.position.set(0, 12, 0);

        // Dark backplate
        signGroup.add(new THREE.Mesh(new THREE.CircleGeometry(2.5, 24), new THREE.MeshBasicMaterial({ color: 0x001122, transparent: true, opacity: 0.85, side: THREE.DoubleSide })));

        // Ring
        signGroup.add(new THREE.Mesh(new THREE.RingGeometry(2.5, 2.8, 24), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, side: THREE.DoubleSide })));

        // Direction arrow canvas
        const cv = document.createElement('canvas');
        cv.width = 128; cv.height = 128;
        const ctx = cv.getContext('2d');
        ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
        ctx.lineWidth = 14; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.shadowColor = isNext ? '#00f0ff' : '#b000ff'; ctx.shadowBlur = 10;

        ctx.beginPath();
        if (mod.includes('left')) {
            if (mod.includes('sharp')) { ctx.moveTo(90, 100); ctx.lineTo(90, 40); ctx.lineTo(35, 40); ctx.stroke(); ctx.beginPath(); ctx.moveTo(35, 20); ctx.lineTo(15, 40); ctx.lineTo(35, 60); ctx.fill(); }
            else if (mod.includes('slight')) { ctx.moveTo(75, 105); ctx.lineTo(50, 60); ctx.lineTo(35, 30); ctx.stroke(); ctx.beginPath(); ctx.moveTo(20, 40); ctx.lineTo(35, 30); ctx.lineTo(50, 20); ctx.fill(); }
            else { ctx.moveTo(75, 100); ctx.lineTo(75, 60); ctx.lineTo(35, 60); ctx.stroke(); ctx.beginPath(); ctx.moveTo(35, 40); ctx.lineTo(15, 60); ctx.lineTo(35, 80); ctx.fill(); }
        } else if (mod.includes('right')) {
            if (mod.includes('sharp')) { ctx.moveTo(35, 100); ctx.lineTo(35, 40); ctx.lineTo(90, 40); ctx.stroke(); ctx.beginPath(); ctx.moveTo(90, 20); ctx.lineTo(110, 40); ctx.lineTo(90, 60); ctx.fill(); }
            else if (mod.includes('slight')) { ctx.moveTo(50, 105); ctx.lineTo(75, 60); ctx.lineTo(90, 30); ctx.stroke(); ctx.beginPath(); ctx.moveTo(105, 40); ctx.lineTo(90, 30); ctx.lineTo(75, 20); ctx.fill(); }
            else { ctx.moveTo(50, 100); ctx.lineTo(50, 60); ctx.lineTo(90, 60); ctx.stroke(); ctx.beginPath(); ctx.moveTo(90, 40); ctx.lineTo(110, 60); ctx.lineTo(90, 80); ctx.fill(); }
        } else if (mod.includes('uturn')) {
            ctx.moveTo(85, 100); ctx.lineTo(85, 40); ctx.arc(64, 40, 21, 0, Math.PI, true); ctx.lineTo(43, 75); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(28, 70); ctx.lineTo(43, 95); ctx.lineTo(58, 70); ctx.fill();
        } else {
            ctx.moveTo(64, 110); ctx.lineTo(64, 40); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(44, 50); ctx.lineTo(64, 20); ctx.lineTo(84, 50); ctx.fill();
        }

        const arrowTex = new THREE.CanvasTexture(cv);
        const arrowMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(3.5, 3.5),
            new THREE.MeshBasicMaterial({ map: arrowTex, transparent: true, depthWrite: false })
        );
        arrowMesh.position.z = 0.1;
        signGroup.add(arrowMesh);

        g.userData.isBillboardSign = true;
        g.add(signGroup);
        g.position.set(pos.x, 0, pos.z);
        this.pathGroup.add(g);
    },

    // ── DESTINATION PIN ──
    makeDestPin(pos) {
        const g = new THREE.Group();

        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(1.0, 12, 12),
            new THREE.MeshBasicMaterial({ color: 0xff3366, transparent: true, opacity: 0.9 })
        );
        sphere.position.y = 7;
        g.add(sphere);

        g.add(new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.1, 7, 6),
            new THREE.MeshBasicMaterial({ color: 0xff3366 })
        ));
        g.children[1].position.y = 3.5;

        const ring = new THREE.Mesh(
            new THREE.RingGeometry(1.2, 2.0, 24),
            new THREE.MeshBasicMaterial({ color: 0xff3366, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.1;
        g.add(ring);

        g.position.set(pos.x, 0, pos.z);
        g.userData.isDestPin = true;
        this.pathGroup.add(g);
    },

    animate() {
        const t = Date.now() * 0.003;
        const spdMs = window.GPS ? window.GPS.speed : 0;

        // ══════════════════════════════════════════════
        // AR-GPS SYNC
        // Since latLonToLocal is now user-centered (user = 0,0),
        // pathGroup just needs to stay at origin for non-XR,
        // or offset by XR camera position for WebXR
        // ══════════════════════════════════════════════
        if (this.xrActive && window.GPS?.displayLat && window.RouteManager?.originLat) {
            // In XR, the camera moves in real space. 
            // We need to offset the pathGroup so the route stays geo-anchored.
            const gpsL = window.RouteManager.latLonToLocal(window.GPS.displayLat, window.GPS.displayLon);
            const tX = this.camera.position.x - gpsL.x;
            const tZ = this.camera.position.z - gpsL.z;

            // Smooth exponential approach (simpler than spring-mass)
            this.pathGroup.position.x += (tX - this.pathGroup.position.x) * 0.15;
            this.pathGroup.position.z += (tZ - this.pathGroup.position.z) * 0.15;

            // World rotation calibration when moving
            if (spdMs > 2.0) {
                const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
                const targetY = -(euler.y + THREE.MathUtils.degToRad(window.GPS.smoothHeading));
                let dY = targetY - this.pathGroup.rotation.y;
                while (dY > Math.PI) dY -= Math.PI * 2;
                while (dY < -Math.PI) dY += Math.PI * 2;
                this.pathGroup.rotation.y += dY * 0.05;
            }
        }

        // Animate children
        this.pathGroup.children.forEach(ch => {
            if (ch.userData.isChevronGroup) {
                const cLen = ch.userData.curve ? ch.userData.curve.getLength() : 100;
                const activeSpd = (1.5 + spdMs * 0.5) / cLen;

                ch.children.forEach(mesh => {
                    mesh.userData.u += activeSpd;
                    if (mesh.userData.u > 1) mesh.userData.u -= 1;

                    const u = mesh.userData.u;
                    try {
                        const pt = ch.userData.curve.getPoint(u);
                        const tan = ch.userData.curve.getTangent(u);
                        mesh.position.copy(pt);
                        mesh.position.y = 0.05;
                        mesh.lookAt(pt.clone().add(tan));
                    } catch(e) {}

                    // Fade at edges
                    const edgeScale = Math.sin(u * Math.PI);
                    const s = Math.max(0.01, Math.min(1, edgeScale * 2));
                    mesh.scale.set(s, s, s);
                });
            }

            if (ch.userData.isBillboardSign) {
                ch.lookAt(this.camera.position.x, ch.position.y, this.camera.position.z);
                if (ch.children[1]) ch.children[1].position.y = 12 + Math.sin(t * 1.5) * 0.3;
            }

            if (ch.userData.isDestPin) {
                ch.rotation.y = t * 0.25;
                if (ch.children[0]) ch.children[0].position.y = 7 + Math.sin(t * 1.5) * 0.25;
            }
        });

        this.renderer.render(this.scene, this.camera);
    }
};
