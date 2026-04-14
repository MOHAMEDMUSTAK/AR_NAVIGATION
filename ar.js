// ar.js — PrecisionAR Drive v3
// Real 3D Arrow Geometry, Gradient Path, Destination Pin, Smooth SLAM Bypass

window.ARScene = {
    scene: null, camera: null, renderer: null,
    pathGroup: new THREE.Group(),
    chevronMat: null,
    xrActive: false, initialHeading: null,
    targetPos: { x:0, z:0 }, lerp: 0.12,

    init() {
        const c = document.getElementById('ar-container');
        if (!c) return;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.01, 1000);

        this.renderer = new THREE.WebGLRenderer({ alpha:true, antialias:true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.renderer.xr.enabled = true;
        c.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const dl = new THREE.DirectionalLight(0xffffff, 0.6);
        dl.position.set(0, 10, 5);
        this.scene.add(dl);

        this.scene.add(this.pathGroup);
        this.createChevron();

        // Compass fallback for non-WebXR
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
        cv.width = 256; cv.height = 256;
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, 256, 256);

        // Futuristic Multi-Layer Neon Chevron Outline
        ctx.lineCap = 'round';
        ctx.lineJoin = 'miter';
        ctx.miterLimit = 2; // sharper tip

        // Outer Glow
        ctx.shadowColor = '#00f0ff';
        ctx.shadowBlur = 25;
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 35;
        
        ctx.beginPath();
        ctx.moveTo(30, 190);
        ctx.lineTo(128, 70);
        ctx.lineTo(226, 190);
        ctx.stroke();
        
        // Inner intense white hot core
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#ffffff';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 14;

        ctx.beginPath();
        ctx.moveTo(30, 190);
        ctx.lineTo(128, 70);
        ctx.lineTo(226, 190);
        ctx.stroke();

        const tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = 16;

        // Removed AdditiveBlending because many Android WebXR browsers drop the alpha channel entirely
        // and render the path invisible against camera feeds. Using pure opacity solves "missing arrows".
        this.chevronMat = new THREE.MeshBasicMaterial({
            map: tex, color: 0xffffff, 
            transparent: true, opacity: 0.95, side: THREE.DoubleSide, 
            depthWrite: false
        });
    },

    buildPath() {
        if (!window.RouteManager || window.RouteManager.pathCoordinates.length < 2) return;

        // Clear old
        while (this.pathGroup.children.length) {
            const ch = this.pathGroup.children[0];
            if (ch.traverse) ch.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
            this.pathGroup.remove(ch);
        }

        this.pathGroup.position.set(0, 0, 0);
        if (this.xrActive && this.initialHeading !== null) {
            this.pathGroup.rotation.y = THREE.MathUtils.degToRad(-this.initialHeading);
        }

        // CRITICAL: Scoped Physical Distance Rendering
        // Only build the path from the camera's feet out to exactly 250 physical meters!
        const pts = [];

        // Bridge Fix: Force the exact live GPS location to be the very first point.
        // This guarantees the AR path physically crawls entirely from the bottom of the user's screen out to the road!
        if (window.GPS?.currentLat && window.RouteManager?.originLat) {
            const userL = window.RouteManager.latLonToLocal(window.GPS.currentLat, window.GPS.currentLon);
            pts.push(new THREE.Vector3(userL.x, 0.05, userL.z));
        }

        const srCtx = window.RouteManager.lastSnapIndex || 0;
        const curCoords = window.RouteManager.pathCoordinates;
        
        let pathDist = 0;
        if (curCoords[srCtx]) {
            // Ignore the first OSRM point if it's identical or super close to the user to prevent ugly kinks
            const startL = window.RouteManager.latLonToLocal(curCoords[srCtx].lat, curCoords[srCtx].lon);
            if (pts.length === 0 || pts[0].distanceTo(new THREE.Vector3(startL.x, 0.05, startL.z)) > 3) {
                pts.push(new THREE.Vector3(startL.x, 0.05, startL.z));
            }
            
            for (let i = srCtx + 1; i < curCoords.length; i++) {
                const l = window.RouteManager.latLonToLocal(curCoords[i].lat, curCoords[i].lon);
                const v = new THREE.Vector3(l.x, 0.05, l.z);
                pathDist += pts[pts.length - 1].distanceTo(v);
                pts.push(v);
                if (pathDist > 250) break; // Limit drastically to enforce dense packing right in front of the car
            }
        }

        if (pts.length >= 2) {
            const curve = new THREE.CatmullRomCurve3(pts);
            const pathLen = curve.getLength();
            
            // Dense repeating neon chevrons 
            const arrowCount = Math.max(15, Math.floor(pathLen / 1.5));
            const arrowGeo = new THREE.PlaneGeometry(3.8, 3.8); // Adjusted size to match lane scale
            arrowGeo.rotateX(-Math.PI / 2); // Lay flat on the asphalt
            // Removed rotateY(Math.PI) to ensure the chevron canvas points FORWARD along the 3D curve
            
            const arrowGroup = new THREE.Group();
            for(let i=0; i<=arrowCount; i++) {
                if (arrowCount === 0) break;
                const u = i / arrowCount;
                if (u === 0 || u === 1) continue;
                
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

            // 2. Left and Right neon glowing green lane borders
            const segs = Math.max(20, Math.floor(pathLen));
            const frames = curve.computeFrenetFrames(segs, false);
            const leftPts = []; const rightPts = [];
            for(let i=0; i<=segs; i++) {
                const pt = curve.getPoint(i/segs);
                const pL = new THREE.Vector3().copy(pt).addScaledVector(frames.binormals[i], 2.2);
                const pR = new THREE.Vector3().copy(pt).addScaledVector(frames.binormals[i], -2.2);
                leftPts.push(pL); rightPts.push(pR);
            }
            const lineMat = new THREE.LineBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.85, linewidth: 4 });
            const lineL = new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts), lineMat);
            const lineR = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts), lineMat);
            lineL.position.y = 0.06; lineR.position.y = 0.06;
            this.pathGroup.add(lineL);
            this.pathGroup.add(lineR);
        }

        // 3D Turn Arrows (LOD: 250m)
        const steps = window.RouteManager.steps;
        const cur = window.RouteManager.currentStepIndex;

        for (let i = cur; i < Math.min(cur + 5, steps.length); i++) {
            const step = steps[i];
            if (!step.maneuver?.location) continue;
            const loc = step.maneuver.location;
            const mod = step.maneuver.modifier || 'straight';
            const lp = window.RouteManager.latLonToLocal(loc[1], loc[0]);
            const d = Math.sqrt(lp.x ** 2 + lp.z ** 2);
            // Show perfectly visible holographic signs for all non-straight turns
            if (d < 250 && mod !== 'straight') this.make3DArrow(lp, mod, i === cur);
        }

        // Destination pin
        if (window.RouteManager.destLat) {
            const dp = window.RouteManager.latLonToLocal(window.RouteManager.destLat, window.RouteManager.destLon);
            if (Math.sqrt(dp.x**2 + dp.z**2) < 800) this.makeDestPin(dp);
        }
    },

    // ── REAL 3D ARROW ──
    make3DArrow(pos, mod, isNext) {
        const g = new THREE.Group();
        const col = isNext ? 0x00f0ff : 0xb000ff;

        // Vertical holographic beam pointing to the turn
        const beamGeo = new THREE.CylinderGeometry(1.5, 0.4, 12, 16, 1, true);
        beamGeo.translate(0, 6, 0); 
        const beamMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
        const beam = new THREE.Mesh(beamGeo, beamMat);
        g.add(beam);

        // Floating Circular UI Sign
        const signGroup = new THREE.Group();
        signGroup.position.set(0, 14, 0); // Float high in air

        // Dark Backplate
        const bgMat = new THREE.MeshBasicMaterial({ color: 0x001122, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
        signGroup.add(new THREE.Mesh(new THREE.CircleGeometry(3, 32), bgMat));

        // Highlight Ring
        const ringMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
        signGroup.add(new THREE.Mesh(new THREE.RingGeometry(3, 3.4, 32), ringMat));

        // Dynamic Route Direction Canvas 
        const cv = document.createElement('canvas');
        cv.width = 256; cv.height = 256;
        const ctx = cv.getContext('2d');
        ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
        ctx.lineWidth = 26; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.shadowColor = isNext ? '#00f0ff' : '#b000ff'; ctx.shadowBlur = 15;
        
        ctx.beginPath();
        if (mod.includes('left')) {
            if (mod.includes('sharp')) { ctx.moveTo(180, 200); ctx.lineTo(180, 80); ctx.lineTo(70, 80); ctx.stroke(); ctx.beginPath(); ctx.moveTo(70, 40); ctx.lineTo(30, 80); ctx.lineTo(70, 120); ctx.fill(); }
            else if (mod.includes('slight')) { ctx.moveTo(150, 210); ctx.lineTo(100, 120); ctx.lineTo(70, 60); ctx.stroke(); ctx.beginPath(); ctx.moveTo(40, 80); ctx.lineTo(70, 60); ctx.lineTo(100, 40); ctx.fill(); }
            else { ctx.moveTo(150, 200); ctx.lineTo(150, 120); ctx.lineTo(70, 120); ctx.stroke(); ctx.beginPath(); ctx.moveTo(70, 80); ctx.lineTo(30, 120); ctx.lineTo(70, 160); ctx.fill(); }
        } else if (mod.includes('right')) {
            if (mod.includes('sharp')) { ctx.moveTo(70, 200); ctx.lineTo(70, 80); ctx.lineTo(180, 80); ctx.stroke(); ctx.beginPath(); ctx.moveTo(180, 40); ctx.lineTo(220, 80); ctx.lineTo(180, 120); ctx.fill(); }
            else if (mod.includes('slight')) { ctx.moveTo(100, 210); ctx.lineTo(150, 120); ctx.lineTo(180, 60); ctx.stroke(); ctx.beginPath(); ctx.moveTo(210, 80); ctx.lineTo(180, 60); ctx.lineTo(150, 40); ctx.fill(); }
            else { ctx.moveTo(100, 200); ctx.lineTo(100, 120); ctx.lineTo(180, 120); ctx.stroke(); ctx.beginPath(); ctx.moveTo(180, 80); ctx.lineTo(220, 120); ctx.lineTo(180, 160); ctx.fill(); }
        } else if (mod.includes('uturn')) {
            ctx.moveTo(170, 200); ctx.lineTo(170, 80); ctx.arc(128, 80, 42, 0, Math.PI, true); ctx.lineTo(86, 150); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(56, 140); ctx.lineTo(86, 190); ctx.lineTo(116, 140); ctx.fill();
        } else {
            ctx.moveTo(128, 220); ctx.lineTo(128, 80); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(88, 100); ctx.lineTo(128, 40); ctx.lineTo(168, 100); ctx.fill();
        }

        const arrowTex = new THREE.CanvasTexture(cv);
        const arrowMesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ map: arrowTex, transparent: true, depthWrite: false }));
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

        // Sphere
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(1.2, 16, 16),
            new THREE.MeshLambertMaterial({ color: 0xff3366, emissive: 0xaa1133, transparent: true, opacity: 0.9 })
        );
        sphere.position.y = 8;
        g.add(sphere);

        // Stick
        g.add(new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.12, 8, 8),
            new THREE.MeshLambertMaterial({ color: 0xff3366, emissive: 0x881122 })
        ));
        g.children[1].position.y = 4;

        // Base ring
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(1.3, 2.2, 32),
            new THREE.MeshBasicMaterial({ color: 0xff3366, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.1;
        g.add(ring);

        // Label ring (pulsing)
        const outerRing = new THREE.Mesh(
            new THREE.RingGeometry(2.5, 3, 32),
            new THREE.MeshBasicMaterial({ color: 0xff3366, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
        );
        outerRing.rotation.x = -Math.PI / 2;
        outerRing.position.y = 0.08;
        g.add(outerRing);

        g.position.set(pos.x, 0, pos.z);
        g.userData.isDestPin = true;
        this.pathGroup.add(g);
    },

    animate() {
        const t = Date.now() * 0.003;

        // PERFECT AR-GPS SYNC (Zero Drift)
        // We smoothly bolt the origin of the AR path directly to the physical GPS offset!
        const spdMs = window.GPS ? window.GPS.speed : 0;
        if (this.xrActive && window.GPS?.currentLat && window.RouteManager?.originLat) {
            const gpsL = window.RouteManager.latLonToLocal(window.GPS.currentLat, window.GPS.currentLon);
            const tX = this.camera.position.x - gpsL.x;
            const tZ = this.camera.position.z - gpsL.z;
            this.pathGroup.position.x += (tX - this.pathGroup.position.x) * 0.25;
            this.pathGroup.position.z += (tZ - this.pathGroup.position.z) * 0.25;
            
            // CRITICAL: Dynamic True-North World Calibration
            // If we are moving, the GPS bearing perfectly mathematically determines True North.
            // We gently drift the AR world rotation into absolute alignment, ignoring permanent 
            // compass start errors.
            if (spdMs > 2.0) {
                const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
                // Offset is constant regardless of physical physical rotation
                const targetY = -(euler.y + THREE.MathUtils.degToRad(window.GPS.smoothHeading));
                
                let dY = targetY - this.pathGroup.rotation.y;
                // Normalize wrap
                while(dY > Math.PI) dY -= Math.PI * 2;
                while(dY < -Math.PI) dY += Math.PI * 2;
                
                this.pathGroup.rotation.y += dY * 0.05; // Ultra smooth locked drift
            }
        }

        // Animate children
        this.pathGroup.children.forEach(ch => {
            if (ch.userData.isChevronGroup) {
                // Adjust animation speed completely proportional to the physical curve length
                const cLen = ch.userData.curve.getLength() || 100;
                const activeSpd = (2.0 + spdMs) / cLen;
                
                ch.children.forEach(mesh => {
                    // Flow forwards OUT of the camera rather than reversing into it!
                    mesh.userData.u += activeSpd;
                    if (mesh.userData.u > 1) mesh.userData.u -= 1;
                    
                    const u = mesh.userData.u;
                    const pt = ch.userData.curve.getPoint(u);
                    const tan = ch.userData.curve.getTangent(u);
                    mesh.position.copy(pt);
                    mesh.position.y = 0.05;
                    mesh.lookAt(pt.clone().add(tan));
                    
                    // Scale smoothly at edges
                    const edgeScale = Math.sin(u * Math.PI);
                    const s = Math.max(0.001, Math.min(1, edgeScale * 2)); 
                    mesh.scale.set(s, s, s);
                });
            }

            if (ch.userData.isBillboardSign) {
                // Keep sign facing the camera perfectly
                ch.lookAt(this.camera.position.x, ch.position.y, this.camera.position.z);
                // Float the sign slightly 
                if (ch.children[1]) ch.children[1].position.y = 14 + Math.sin(t * 1.5) * 0.4;
            }
            if (ch.userData.isBillboard) {
                ch.lookAt(this.camera.position.x, ch.position.y, this.camera.position.z);
                ch.position.y = 1.5 + Math.sin(t + ch.position.x) * 0.18;
                if (ch.userData.isNext) {
                    const p = 0.92 + Math.sin(t * 2.5) * 0.1;
                    ch.scale.set(p, p, p);
                }
            }
            if (ch.userData.isDestPin) {
                ch.rotation.y = t * 0.25;
                if (ch.children[0]) ch.children[0].position.y = 8 + Math.sin(t * 1.5) * 0.35;
                // Pulse outer ring
                if (ch.children[3]) {
                    const s = 1 + Math.sin(t * 2) * 0.15;
                    ch.children[3].scale.set(s, s, 1);
                }
            }
        });

        this.renderer.render(this.scene, this.camera);
    }
};
