// ar.js — Production AR v5 — Matches Reference Image
// Dense white chevrons on road, bright green lane lines, floating turn indicators

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
        this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.userData.baseFov = 70;


        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(1.0);
        this.renderer.xr.enabled = true;
        c.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.AmbientLight(0xffffff, 1.0));
        this.scene.add(this.pathGroup);
        this.createChevronTexture();

        // Compass camera for non-WebXR
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

    // ════════════════════════════════════════════════════════
    // CHEVRON TEXTURE — Matches reference: white V chevron
    // with cyan glow, looks like road lane markings
    // ════════════════════════════════════════════════════════
    createChevronTexture() {
        const cv = document.createElement('canvas');
        cv.width = 256; cv.height = 256;
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, 256, 256);

        ctx.lineCap = 'round';
        ctx.lineJoin = 'miter';
        ctx.miterLimit = 2;

        // Layer 1: Wide cyan glow (outer)
        ctx.shadowColor = '#00e5ff';
        ctx.shadowBlur = 35;
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
        ctx.lineWidth = 44;
        ctx.beginPath();
        ctx.moveTo(28, 195);
        ctx.lineTo(128, 65);
        ctx.lineTo(228, 195);
        ctx.stroke();

        // Layer 2: Bright Cyan core (matching reference)
        ctx.shadowColor = '#00ffff';
        ctx.shadowBlur = 15;
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 20;
        ctx.beginPath();
        ctx.moveTo(28, 195);
        ctx.lineTo(128, 65);
        ctx.lineTo(228, 195);
        ctx.stroke();

        // Layer 3: Intense white center highlight
        ctx.shadowBlur = 5;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(28, 195);
        ctx.lineTo(128, 65);
        ctx.lineTo(228, 195);
        ctx.stroke();

        const tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = 4;

        this.chevronMat = new THREE.MeshBasicMaterial({
            map: tex, color: 0xffffff,
            transparent: true, opacity: 0.92,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        
        // Cache geometry globally to prevent massive GC lag every 60m
        this.sharedArrowGeo = new THREE.PlaneGeometry(4.2, 4.2);
        this.sharedArrowGeo.rotateX(-Math.PI / 2);
    },

    // ════════════════════════════════════════════════════════
    // BUILD PATH — Dense chevrons + bright green lane lines
    // ════════════════════════════════════════════════════════
    buildPath() {
        if (!window.RouteManager || window.RouteManager.pathCoordinates.length < 2) return;

        const now = Date.now();
        if (now - this.lastBuildTime < 180) return;
        this.lastBuildTime = now;

        // Clear old
        while (this.pathGroup.children.length) {
            const ch = this.pathGroup.children[0];
            if (ch.traverse) ch.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material && o.material !== this.chevronMat) o.material.dispose();
            });
            this.pathGroup.remove(ch);
        }

        this.pathGroup.position.set(0, 0, 0);
        this.pathGroup.rotation.set(0, 0, 0);

        if (this.xrActive && this.initialHeading !== null) {
            this.pathGroup.rotation.y = THREE.MathUtils.degToRad(this.initialHeading);
        }

        // Build path points from snapped index
        const pts = [];
        const srCtx = window.RouteManager.lastSnapIndex || 0;
        const curCoords = window.RouteManager.pathCoordinates;
        let pathDist = 0;
        const maxDist = 1500; // Expanded horizon mapping

        for (let i = srCtx; i < curCoords.length; i++) {
            const l = window.RouteManager.latLonToLocal(curCoords[i].lat, curCoords[i].lon);
            const v = new THREE.Vector3(l.x, 0.15, l.z); // Elevated to 15cm
            if (pts.length > 0) {
                const d = pts[pts.length - 1].distanceTo(v);
                if (d < 0.3) continue; // Skip too-close points
                pathDist += d;
            }
            pts.push(v);
            if (pathDist > maxDist) break;
        }

        if (pts.length < 2) return;

        // Linear geometry prevents aggressive intersection "cutting"
        const curve = new THREE.CurvePath();
        for (let i = 0; i < pts.length - 1; i++) {
            curve.add(new THREE.LineCurve3(pts[i], pts[i+1]));
        }
        const pathLen = curve.getLength();

        // ──────────────────────────────────────────────
        // 1. DENSE WHITE CHEVRONS (matching reference)
        //    Spaced every ~1.2m for ultra-dense road coverage
        // ──────────────────────────────────────────────
        const chevronSpacing = 1.2;
        const arrowCount = Math.max(15, Math.min(150, Math.floor(pathLen / chevronSpacing)));

        const arrowGroup = new THREE.Group();
        for (let i = 1; i < arrowCount; i++) {
            const u = i / arrowCount;
            try {
                const pt = curve.getPoint(u);
                const tangent = curve.getTangent(u);
                const mesh = new THREE.Mesh(this.sharedArrowGeo, this.chevronMat);
                mesh.position.copy(pt);
                mesh.position.y = 0.15;
                const target = pt.clone().add(tangent);
                mesh.lookAt(target);
                mesh.userData.u = u;
                mesh.userData.baseU = u;
                arrowGroup.add(mesh);
            } catch(e) {}
        }
        arrowGroup.userData.isChevronGroup = true;
        arrowGroup.userData.curve = curve;
        this.pathGroup.add(arrowGroup);

        // ──────────────────────────────────────────────
        // 2. BRIGHT GREEN LANE BORDER LINES
        //    Matching reference: solid neon green
        // ──────────────────────────────────────────────
        const leftPts = [], rightPts = [];
        const laneWidth = 2.5; // Half-width of the lane

        for (let i = 0; i < pts.length - 1; i++) {
            const A = pts[i];
            const B = pts[i+1];
            const dir = new THREE.Vector3().subVectors(B, A).normalize();
            // True linear binormals to prevent splines from tearing on sharp corners
            const binormal = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
            
            const pL = new THREE.Vector3().copy(A).addScaledVector(binormal, laneWidth);
            const pR = new THREE.Vector3().copy(A).addScaledVector(binormal, -laneWidth);
            pL.y = 0.16; pR.y = 0.16; // Slight anti-z-fight bump over chevrons
            leftPts.push(pL); rightPts.push(pR);
            
            if (i === pts.length - 2) {
                const epL = new THREE.Vector3().copy(B).addScaledVector(binormal, laneWidth);
                const epR = new THREE.Vector3().copy(B).addScaledVector(binormal, -laneWidth);
                epL.y = 0.16; epR.y = 0.16;
                leftPts.push(epL); rightPts.push(epR);
            }
        }

        // Create thicker lane lines using tube-like line rendering
        const greenMat = new THREE.LineBasicMaterial({
            color: 0x00ff44,
            transparent: true,
            opacity: 0.85,
            linewidth: 3
        });
        const lineL = new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts), greenMat);
        const lineR = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts), greenMat);
        this.pathGroup.add(lineL);
        this.pathGroup.add(lineR);

        // Also add thin mesh strips for the lane lines (visible thickness on mobile)
        this.addLaneStrip(leftPts, 0x00ff44, 0.35);
        this.addLaneStrip(rightPts, 0x00ff44, 0.35);

        // ──────────────────────────────────────────────
        // 3. FLOATING TURN INDICATORS (blue circle + arrow)
        //    Matching reference: 3D floating signage
        // ──────────────────────────────────────────────
        const steps = window.RouteManager.steps;
        const cur = window.RouteManager.currentStepIndex;

        for (let i = cur; i < Math.min(cur + 4, steps.length); i++) {
            const step = steps[i];
            if (!step.maneuver?.location) continue;
            const loc = step.maneuver.location;
            const mod = step.maneuver.modifier || 'straight';
            const lp = window.RouteManager.latLonToLocal(loc[1], loc[0]);
            const d = Math.sqrt(lp.x ** 2 + lp.z ** 2);
            if (d < 200 && d > 3) {
                this.makeFloatingTurnSign(lp, mod, i === cur, step, d);
            }
        }

        // Destination pin
        if (window.RouteManager.destLat) {
            const dp = window.RouteManager.latLonToLocal(window.RouteManager.destLat, window.RouteManager.destLon);
            if (Math.sqrt(dp.x ** 2 + dp.z ** 2) < 500) this.makeDestPin(dp);
        }
    },

    // ── Lane Strip (thin mesh for visible line thickness) ──
    addLaneStrip(points, color, width) {
        if (points.length < 2) return;
        const positions = [];
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i], p2 = points[i + 1];
            const dx = p2.x - p1.x, dz = p2.z - p1.z;
            const len = Math.sqrt(dx * dx + dz * dz);
            if (len === 0) continue;
            const nx = -dz / len * width * 0.5, nz = dx / len * width * 0.5;
            positions.push(
                p1.x + nx, p1.y, p1.z + nz,
                p1.x - nx, p1.y, p1.z - nz,
                p2.x + nx, p2.y, p2.z + nz,
                p2.x - nx, p2.y, p2.z - nz,
                p2.x + nx, p2.y, p2.z + nz,
                p1.x - nx, p1.y, p1.z - nz
            );
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.computeVertexNormals();
        const mat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        this.pathGroup.add(mesh);
    },

    // ════════════════════════════════════════════════════════
    // FLOATING TURN SIGN — Blue circle with direction arrow
    // Matches reference: "Crescent St 50 ft" floating indicator
    // ════════════════════════════════════════════════════════
    makeFloatingTurnSign(pos, mod, isNext, step, distMeters) {
        if (mod === 'straight' && !isNext) return;

        const g = new THREE.Group();
        const col = isNext ? 0x00b8ff : 0x8844ff;

        // Vertical beacon
        const beamGeo = new THREE.CylinderGeometry(0.8, 0.2, 10, 8, 1, true);
        beamGeo.translate(0, 5, 0);
        const beamMat = new THREE.MeshBasicMaterial({
            color: col, transparent: true, opacity: 0.25,
            side: THREE.DoubleSide, depthWrite: false
        });
        g.add(new THREE.Mesh(beamGeo, beamMat));

        // Floating sign
        const signGroup = new THREE.Group();
        signGroup.position.set(0, 14, 0);

        // Dark circle backplate
        const bgMat = new THREE.MeshBasicMaterial({
            color: 0x051525, transparent: true, opacity: 0.9, side: THREE.DoubleSide
        });
        signGroup.add(new THREE.Mesh(new THREE.CircleGeometry(3.2, 32), bgMat));

        // Blue glowing ring
        const ringMat = new THREE.MeshBasicMaterial({
            color: col, transparent: true, opacity: 0.95, side: THREE.DoubleSide
        });
        signGroup.add(new THREE.Mesh(new THREE.RingGeometry(3.2, 3.6, 32), ringMat));

        // Outer glow ring
        const outerGlowMat = new THREE.MeshBasicMaterial({
            color: col, transparent: true, opacity: 0.2, side: THREE.DoubleSide
        });
        signGroup.add(new THREE.Mesh(new THREE.RingGeometry(3.6, 4.2, 32), outerGlowMat));

        // Direction arrow canvas
        const cv = document.createElement('canvas');
        cv.width = 256; cv.height = 256;
        const ctx = cv.getContext('2d');

        // Draw arrow
        ctx.strokeStyle = '#ffffff';
        ctx.fillStyle = '#ffffff';
        ctx.lineWidth = 16;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = isNext ? '#00b8ff' : '#8844ff';
        ctx.shadowBlur = 12;

        this.drawDirectionArrow(ctx, mod);

        // Street name text
        const streetName = step.name || '';
        if (streetName && streetName.length < 20) {
            ctx.shadowBlur = 0;
            ctx.font = "bold 22px 'Arial', sans-serif";
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.textAlign = 'center';
            ctx.fillText(streetName.substring(0, 15), 128, 235);
        }

        const arrowTex = new THREE.CanvasTexture(cv);
        const arrowMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(4.5, 4.5),
            new THREE.MeshBasicMaterial({ map: arrowTex, transparent: true, depthWrite: false })
        );
        arrowMesh.position.z = 0.15;
        signGroup.add(arrowMesh);

        // Distance plate below the sign
        if (isNext) {
            const distCv = document.createElement('canvas');
            distCv.width = 256;
            distCv.height = 64;
            const dCtx = distCv.getContext('2d');
            dCtx.fillStyle = 'rgba(0,0,0,0.8)';
            dCtx.roundRect(16, 4, 224, 52, 12);
            dCtx.fill();
            dCtx.font = "bold 32px 'Arial', sans-serif";
            dCtx.fillStyle = '#00e5ff';
            dCtx.textAlign = 'center';
            const distText = distMeters >= 1000 ? `${(distMeters/1000).toFixed(1)} km` : `${Math.round(distMeters)}m`;
            dCtx.fillText(distText, 128, 42);

            const distTex = new THREE.CanvasTexture(distCv);
            const distMesh = new THREE.Mesh(
                new THREE.PlaneGeometry(4, 1),
                new THREE.MeshBasicMaterial({ map: distTex, transparent: true, depthWrite: false })
            );
            distMesh.position.set(0, -4.2, 0.1);
            signGroup.add(distMesh);
        }

        g.userData.isBillboardSign = true;
        g.add(signGroup);
        g.position.set(pos.x, 0, pos.z);
        this.pathGroup.add(g);
    },

    drawDirectionArrow(ctx, mod) {
        ctx.beginPath();
        if (mod.includes('left')) {
            if (mod.includes('sharp')) {
                ctx.moveTo(180, 190); ctx.lineTo(180, 80); ctx.lineTo(65, 80); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(65, 40); ctx.lineTo(25, 80); ctx.lineTo(65, 120); ctx.fill();
            } else if (mod.includes('slight')) {
                ctx.moveTo(155, 200); ctx.lineTo(105, 110); ctx.lineTo(70, 55); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(38, 72); ctx.lineTo(70, 55); ctx.lineTo(88, 28); ctx.fill();
            } else {
                ctx.moveTo(155, 195); ctx.lineTo(155, 110); ctx.lineTo(65, 110); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(65, 70); ctx.lineTo(25, 110); ctx.lineTo(65, 150); ctx.fill();
            }
        } else if (mod.includes('right')) {
            if (mod.includes('sharp')) {
                ctx.moveTo(76, 190); ctx.lineTo(76, 80); ctx.lineTo(191, 80); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(191, 40); ctx.lineTo(231, 80); ctx.lineTo(191, 120); ctx.fill();
            } else if (mod.includes('slight')) {
                ctx.moveTo(101, 200); ctx.lineTo(151, 110); ctx.lineTo(186, 55); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(218, 72); ctx.lineTo(186, 55); ctx.lineTo(168, 28); ctx.fill();
            } else {
                ctx.moveTo(101, 195); ctx.lineTo(101, 110); ctx.lineTo(191, 110); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(191, 70); ctx.lineTo(231, 110); ctx.lineTo(191, 150); ctx.fill();
            }
        } else if (mod.includes('uturn')) {
            ctx.moveTo(168, 195); ctx.lineTo(168, 80);
            ctx.arc(128, 80, 40, 0, Math.PI, true);
            ctx.lineTo(88, 155); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(58, 145); ctx.lineTo(88, 195); ctx.lineTo(118, 145); ctx.fill();
        } else {
            // Straight
            ctx.moveTo(128, 210); ctx.lineTo(128, 70); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(88, 95); ctx.lineTo(128, 35); ctx.lineTo(168, 95); ctx.fill();
        }
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

    // ════════════════════════════════════════════════════════
    // ANIMATE LOOP
    // ════════════════════════════════════════════════════════
    animate() {
        const t = Date.now() * 0.003;
        const spdMs = window.GPS ? window.GPS.speed : 0;

        // AR-GPS sync
        if (this.xrActive && window.GPS?.displayLat && window.RouteManager?.originLat) {
            const gpsL = window.RouteManager.latLonToLocal(window.GPS.displayLat, window.GPS.displayLon);
            const tX = this.camera.position.x - gpsL.x;
            const tZ = this.camera.position.z - gpsL.z;
            // Eliminate tracking lag: match AR camera coordinates immediately (0.8 instead of 0.15)
            this.pathGroup.position.x += (tX - this.pathGroup.position.x) * 0.8;
            this.pathGroup.position.z += (tZ - this.pathGroup.position.z) * 0.8;

            if (spdMs > 2.0) {
                const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
                // Correctly mapping clockwise initial heading into standard counter-clockwise space
                const targetY = euler.y + THREE.MathUtils.degToRad(window.GPS.smoothHeading);
                let dY = targetY - this.pathGroup.rotation.y;
                while (dY > Math.PI) dY -= Math.PI * 2;
                while (dY < -Math.PI) dY += Math.PI * 2;
                this.pathGroup.rotation.y += dY * 0.08; // Smother rotation
            }
            
            // DYNAMIC FOV: Zoom out at higher speeds to show more road
            const targetFov = this.camera.userData.baseFov + Math.min(15, spdMs * 1.2);
            if (Math.abs(this.camera.fov - targetFov) > 0.1) {
                this.camera.fov += (targetFov - this.camera.fov) * 0.05;
                this.camera.updateProjectionMatrix();
            }
        }


        // Animate children
        this.pathGroup.children.forEach(ch => {
            // Chevron flow animation
            if (ch.userData.isChevronGroup && ch.userData.curve) {
                const cLen = ch.userData.curve.getLength() || 100;
                // Speed-proportional flow
                const flowSpeed = (1.0 + spdMs * 0.4) / cLen;

                ch.children.forEach(mesh => {
                    mesh.userData.u += flowSpeed;
                    if (mesh.userData.u > 1) mesh.userData.u -= 1;

                    const u = mesh.userData.u;
                    try {
                        const pt = ch.userData.curve.getPoint(u);
                        const tan = ch.userData.curve.getTangent(u);
                        mesh.position.copy(pt);
                        mesh.position.y = 0.15;
                        mesh.lookAt(pt.clone().add(tan));
                    } catch(e) {}

                    // Fade edges smoothly
                    const edgeFade = Math.sin(u * Math.PI);
                    const s = Math.max(0.01, Math.min(1, edgeFade * 1.8));
                    mesh.scale.set(s, s, s);
                });
            }

            // Billboard signs always face camera
            if (ch.userData.isBillboardSign) {
                ch.lookAt(this.camera.position.x, ch.position.y, this.camera.position.z);
                // Gentle float
                if (ch.children[1]) {
                    ch.children[1].position.y = 14 + Math.sin(t * 1.2) * 0.3;
                }
            }

            // Destination pin
            if (ch.userData.isDestPin) {
                ch.rotation.y = t * 0.25;
                if (ch.children[0]) ch.children[0].position.y = 7 + Math.sin(t * 1.5) * 0.25;
            }
        });

        this.renderer.render(this.scene, this.camera);
    }
};
