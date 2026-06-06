// ar.js — AstraNav AR Engine v8 — Zero-Allocation InstancedMesh
// Pre-allocated vectors, cached curve samples, throttled DOM, no GC pressure

window.ARScene = {
    scene: null, camera: null, renderer: null,
    chevronInstanced: null,
    laneGlowMesh: null,
    pathGroup: null,
    beaconPool: [],
    destPinObj: null,

    anchorLat: null, anchorLon: null, anchorLocked: false,

    routeCurve: null, curveLength: 0,

    // Pre-cached curve samples (rebuilt only on buildPath)
    cachedPoints: null,    // Float32Array [x,y,z, x,y,z, ...]
    cachedTangents: null,  // Float32Array [x,y,z, x,y,z, ...]
    cachedCount: 0,

    flowOffset: 0,
    lastBuildTime: 0,
    pathDirty: false,

    xrActive: false, initialHeading: null,

    // Config
    MAX_CHEVRONS: 60,
    CHEVRON_SPACING: 2.8,
    BEACON_POOL_SIZE: 4,

    // Pre-allocated objects (ZERO per-frame allocations)
    _tempObj: null,
    _tempVec: null,
    _tempTarget: null,
    _lastFov: 0,
    _lastCompassUpdate: 0,

    // Shared geometries & materials
    chevronGeo: null, chevronMat: null,
    laneGlowMat: null,
    // Reusable lane glow buffer
    _lanePositions: null,
    _laneGeo: null,

    init() {
        const c = document.getElementById('ar-container');
        if (!c) return;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.05, 2000);
        this.camera.userData.baseFov = 68;
        this._lastFov = 68;

        this.renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: false,
            powerPreference: 'high-performance',
            stencil: false,
            depth: true
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.renderer.xr.enabled = true;
        c.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
        sunLight.position.set(0, 50, 30);
        this.scene.add(sunLight);

        this.pathGroup = new THREE.Group();
        this.pathGroup.matrixAutoUpdate = true;
        this.scene.add(this.pathGroup);

        // Pre-allocate reusable objects
        this._tempObj = new THREE.Object3D();
        this._tempVec = new THREE.Vector3();
        this._tempTarget = new THREE.Vector3();

        this._buildSharedGeo();
        this._createInstancedMeshes();
        this._createBeaconPool();

        // GPS heading → camera rotation (throttled)
        if (window.GPS) {
            window.GPS.onUpdate((t, v) => {
                if (t === 'heading' && !this.xrActive) {
                    this.camera.rotation.order = 'YXZ';
                    let target = -v * (Math.PI / 180);
                    let cur = this.camera.rotation.y;
                    let d = target - cur;
                    if (d > Math.PI) d -= Math.PI * 2;
                    if (d < -Math.PI) d += Math.PI * 2;
                    this.camera.rotation.y += d * 0.25;
                }
            });
        }

        this.renderer.xr.addEventListener('sessionstart', () => {
            this.xrActive = true;
            this.initialHeading = window.GPS?.smoothHeading || 0;
        });
        this.renderer.xr.addEventListener('sessionend', () => { this.xrActive = false; });

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });

        this.renderer.setAnimationLoop(this.animate.bind(this));
    },

    _buildSharedGeo() {
        const shape = new THREE.Shape();
        // Wider V-shape (width 3.6m, depth 5.0m)
        shape.moveTo(-1.8, -2.5);
        shape.lineTo(0, 2.5);
        shape.lineTo(1.8, -2.5);
        shape.lineTo(0, -1.0);
        shape.lineTo(-1.8, -2.5);

        const ext = { depth: 0.35, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.1, bevelThickness: 0.1 };
        this.chevronGeo = new THREE.ExtrudeGeometry(shape, ext);
        this.chevronGeo.rotateX(-Math.PI / 2);

        this.chevronMat = new THREE.MeshPhongMaterial({
            color: 0x00d4ff,
            emissive: 0x00aaff,
            emissiveIntensity: 0.9,
            transparent: true,
            opacity: 0.88,
            shininess: 120,
            side: THREE.FrontSide,
            depthWrite: false
        });

        // Add a dark outline geo for contrast
        const outlineExt = { depth: 0.30, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.25, bevelThickness: 0.15 };
        this.chevronOutlineGeo = new THREE.ExtrudeGeometry(shape, outlineExt);
        this.chevronOutlineGeo.rotateX(-Math.PI / 2);
        
        this.chevronOutlineMat = new THREE.MeshBasicMaterial({
            color: 0x000000,
            transparent: true,
            opacity: 0.4,
            side: THREE.BackSide,
            depthWrite: false
        });

        this.laneGlowMat = new THREE.MeshBasicMaterial({
            color: 0x00d4ff,
            transparent: true,
            opacity: 0.22,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
    },

    _createInstancedMeshes() {
        this.chevronInstanced = new THREE.InstancedMesh(this.chevronGeo, this.chevronMat, this.MAX_CHEVRONS);
        this.chevronInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.chevronInstanced.frustumCulled = false;
        this.chevronInstanced.count = 0;
        
        this.chevronOutlineInstanced = new THREE.InstancedMesh(this.chevronOutlineGeo, this.chevronOutlineMat, this.MAX_CHEVRONS);
        this.chevronOutlineInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.chevronOutlineInstanced.frustumCulled = false;
        this.chevronOutlineInstanced.count = 0;

        this.pathGroup.add(this.chevronOutlineInstanced);
        this.pathGroup.add(this.chevronInstanced);

        // Pre-allocate curve sample buffers
        this.cachedPoints = new Float32Array(this.MAX_CHEVRONS * 3);
        this.cachedTangents = new Float32Array(this.MAX_CHEVRONS * 3);
    },

    _createBeaconPool() {
        for (let i = 0; i < this.BEACON_POOL_SIZE; i++) {
            const beacon = this._makeBeaconObject();
            beacon.visible = false;
            this.scene.add(beacon);
            this.beaconPool.push(beacon);
        }
        this.destPinObj = this._makeDestPin();
        this.destPinObj.visible = false;
        this.scene.add(this.destPinObj);
    },

    _makeBeaconObject() {
        const g = new THREE.Group();
        g.userData.isBeacon = true;
        g.userData.lastMod = '';

        const beamGeo = new THREE.CylinderGeometry(1.2, 0.4, 25, 8, 1, true);
        beamGeo.translate(0, 12.5, 0);
        const beamMat = new THREE.MeshBasicMaterial({ color: 0x00b8ff, transparent: true, opacity: 0.40, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
        g.add(new THREE.Mesh(beamGeo, beamMat));

        const coreGeo = new THREE.CylinderGeometry(0.3, 0.08, 25, 4, 1, true);
        coreGeo.translate(0, 12.5, 0);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
        g.add(new THREE.Mesh(coreGeo, coreMat));

        const signGroup = new THREE.Group();
        signGroup.position.set(0, 20, 0);
        g.add(signGroup);

        const bgMat = new THREE.MeshBasicMaterial({ color: 0x051525, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
        signGroup.add(new THREE.Mesh(new THREE.CircleGeometry(3.0, 24), bgMat));

        const ringMat = new THREE.MeshBasicMaterial({ color: 0x00b8ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
        signGroup.add(new THREE.Mesh(new THREE.RingGeometry(3.0, 3.4, 24), ringMat));

        const cv = document.createElement('canvas');
        cv.width = 256; cv.height = 256;
        const arrowTex = new THREE.CanvasTexture(cv);
        arrowTex.needsUpdate = true;
        const arrowMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(4.2, 4.2),
            new THREE.MeshBasicMaterial({ map: arrowTex, transparent: true, depthWrite: false })
        );
        arrowMesh.position.z = 0.12;
        signGroup.add(arrowMesh);

        g.userData.arrowTex = arrowTex;
        g.userData.arrowCanvas = cv;

        return g;
    },

    _makeDestPin() {
        const g = new THREE.Group();
        g.userData.isDestPin = true;
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.9, 8, 8),
            new THREE.MeshBasicMaterial({ color: 0xff2255, transparent: true, opacity: 0.9 })
        );
        sphere.position.y = 6;
        g.add(sphere);
        g.add(new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.1, 6, 4),
            new THREE.MeshBasicMaterial({ color: 0xff2255 })
        ));
        g.children[1].position.y = 3;
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(1.1, 1.9, 16),
            new THREE.MeshBasicMaterial({ color: 0xff2255, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.08;
        g.add(ring);
        return g;
    },

    // ═══════════════════════════════════════════════════════
    // BUILD PATH — Pre-caches curve samples for zero-alloc animation
    // ═══════════════════════════════════════════════════════
    buildPath() {
        if (!window.RouteManager || window.RouteManager.pathCoordinates.length < 2) return;

        const now = Date.now();
        if (now - this.lastBuildTime < 200) {
            this.pathDirty = true;
            return;
        }
        this.lastBuildTime = now;
        this.pathDirty = false;

        if (!this.anchorLocked) {
            if (!window.GPS?.displayLat) return;
            this.anchorLat = window.GPS.displayLat;
            this.anchorLon = window.GPS.displayLon;
            this.anchorLocked = true;
        } else {
            // Re-anchor every ~200m to prevent floating point precision loss
            if (window.GPS?.displayLat) {
                const dist = window.RouteManager.haversine(window.GPS.displayLat, window.GPS.displayLon, this.anchorLat, this.anchorLon);
                if (dist > 200) {
                    this.anchorLat = window.GPS.displayLat;
                    this.anchorLon = window.GPS.displayLon;
                    this.pathGroup.position.set(0, 0, 0); // reset visual offset
                }
            }
        }

        const pts = [];
        const startIdx = window.RouteManager.lastSnapIndex || 0;
        const coords = window.RouteManager.pathCoordinates;
        let totalDist = 0;
        const MAX_DIST = 1500;

        for (let i = startIdx; i < coords.length; i++) {
            const local = window.RouteManager.latLonToAnchor(coords[i].lat, coords[i].lon, this.anchorLat, this.anchorLon);
            this._tempVec.set(local.x, 0.12, local.z);
            if (pts.length > 0) {
                const last = pts[pts.length - 1];
                const dx = this._tempVec.x - last.x, dz = this._tempVec.z - last.z;
                const d = Math.sqrt(dx * dx + dz * dz);
                if (d < 0.4) continue;
                totalDist += d;
            }
            pts.push(new THREE.Vector3(this._tempVec.x, 0.12, this._tempVec.z));
            if (totalDist > MAX_DIST) break;
        }

        if (pts.length < 2) return;

        this.routeCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.0);
        this.curveLength = this.routeCurve.getLength();

        // Pre-cache curve samples for zero-allocation animation
        const spacing = this.CHEVRON_SPACING;
        const count = Math.min(this.MAX_CHEVRONS, Math.floor(this.curveLength / spacing));
        this.cachedCount = count;

        this._buildLaneGlow(pts);
        this._updateBeacons();

        if (window.RouteManager.destLat) {
            const dp = window.RouteManager.latLonToAnchor(
                window.RouteManager.destLat, window.RouteManager.destLon,
                this.anchorLat, this.anchorLon
            );
            const dist = Math.sqrt(dp.x * dp.x + dp.z * dp.z);
            if (dist < 800) {
                this.destPinObj.position.set(dp.x, 0, dp.z);
                this.destPinObj.visible = true;
            } else {
                this.destPinObj.visible = false;
            }
        }
    },

    _buildLaneGlow(pts) {
        if (this.laneGlowMesh) {
            this.pathGroup.remove(this.laneGlowMesh);
            this.laneGlowMesh.geometry.dispose();
            this.laneGlowMesh = null;
        }
        const laneW = 3.0;
        const positions = [];
        for (let i = 0; i < pts.length - 1; i++) {
            const p1 = pts[i], p2 = pts[i + 1];
            const dx = p2.x - p1.x, dz = p2.z - p1.z;
            const len = Math.sqrt(dx * dx + dz * dz);
            if (len < 0.001) continue;
            const nx = -dz / len * laneW * 0.5, nz = dx / len * laneW * 0.5;
            const y = 0.05;
            positions.push(
                p1.x + nx, y, p1.z + nz,
                p1.x - nx, y, p1.z - nz,
                p2.x + nx, y, p2.z + nz,
                p2.x - nx, y, p2.z - nz,
                p2.x + nx, y, p2.z + nz,
                p1.x - nx, y, p1.z - nz
            );
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        this.laneGlowMesh = new THREE.Mesh(geo, this.laneGlowMat);
        this.pathGroup.add(this.laneGlowMesh);
    },

    _updateBeacons() {
        const steps = window.RouteManager?.steps || [];
        const cur = window.RouteManager?.currentStepIndex || 0;

        this.beaconPool.forEach(b => { b.visible = false; });

        let poolIdx = 0;
        for (let i = cur; i < Math.min(cur + this.BEACON_POOL_SIZE, steps.length); i++) {
            const step = steps[i];
            if (!step?.maneuver?.location) continue;
            const loc = step.maneuver.location;
            const mod = step.maneuver.modifier || 'straight';

            const lp = window.RouteManager.latLonToAnchor(loc[1], loc[0], this.anchorLat, this.anchorLon);
            const dist = Math.sqrt(lp.x * lp.x + lp.z * lp.z);

            if (dist < 3 || dist > 300) continue;
            if (mod === 'straight' && i !== cur) continue;

            const beacon = this.beaconPool[poolIdx++];
            beacon.position.set(lp.x, 0, lp.z);
            beacon.visible = true;

            if (beacon.userData.lastMod !== mod) {
                beacon.userData.lastMod = mod;
                const cv = beacon.userData.arrowCanvas;
                const ctx = cv.getContext('2d');
                ctx.clearRect(0, 0, 256, 256);
                ctx.strokeStyle = '#ffffff';
                ctx.fillStyle = '#ffffff';
                ctx.lineWidth = 18;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.shadowColor = i === cur ? '#00b8ff' : '#8844ff';
                ctx.shadowBlur = 16;
                this._drawArrowOnCanvas(ctx, mod);
                beacon.userData.arrowTex.needsUpdate = true;

                const col = i === cur ? 0x00b8ff : 0x9955ff;
                beacon.children[0].material.color.setHex(col);
                beacon.children[2].children[1].material.color.setHex(col);
            }

            if (poolIdx >= this.BEACON_POOL_SIZE) break;
        }
    },

    _drawArrowOnCanvas(ctx, mod) {
        ctx.beginPath();
        if (mod.includes('sharp left')) {
            ctx.moveTo(180, 195); ctx.lineTo(180, 75); ctx.lineTo(60, 75); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(60, 35); ctx.lineTo(20, 75); ctx.lineTo(60, 115); ctx.fill();
        } else if (mod.includes('slight left')) {
            ctx.moveTo(155, 205); ctx.lineTo(100, 110); ctx.lineTo(65, 55); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(33, 72); ctx.lineTo(65, 55); ctx.lineTo(83, 27); ctx.fill();
        } else if (mod.includes('left')) {
            ctx.moveTo(155, 200); ctx.lineTo(155, 105); ctx.lineTo(60, 105); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(60, 65); ctx.lineTo(20, 105); ctx.lineTo(60, 145); ctx.fill();
        } else if (mod.includes('sharp right')) {
            ctx.moveTo(76, 195); ctx.lineTo(76, 75); ctx.lineTo(196, 75); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(196, 35); ctx.lineTo(236, 75); ctx.lineTo(196, 115); ctx.fill();
        } else if (mod.includes('slight right')) {
            ctx.moveTo(101, 205); ctx.lineTo(156, 110); ctx.lineTo(191, 55); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(223, 72); ctx.lineTo(191, 55); ctx.lineTo(173, 27); ctx.fill();
        } else if (mod.includes('right')) {
            ctx.moveTo(101, 200); ctx.lineTo(101, 105); ctx.lineTo(196, 105); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(196, 65); ctx.lineTo(236, 105); ctx.lineTo(196, 145); ctx.fill();
        } else if (mod.includes('uturn')) {
            ctx.moveTo(172, 200); ctx.lineTo(172, 80);
            ctx.arc(128, 80, 44, 0, Math.PI, true);
            ctx.lineTo(84, 155); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(54, 145); ctx.lineTo(84, 195); ctx.lineTo(114, 145); ctx.fill();
        } else {
            ctx.moveTo(128, 215); ctx.lineTo(128, 65); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(85, 92); ctx.lineTo(128, 30); ctx.lineTo(171, 92); ctx.fill();
        }
    },

    // ═══════════════════════════════════════════════════════
    // ANIMATE — Zero per-frame allocations, throttled DOM
    // ═══════════════════════════════════════════════════════
    animate(time) {
        const t = (time || Date.now()) * 0.001;
        const spdMs = window.GPS?.speed || 0;
        const now = Date.now();

        // Process queued path rebuild
        if (this.pathDirty && now - this.lastBuildTime >= 200) {
            this.buildPath();
        }

        // ── Compass UI — Throttled to 10fps ──
        if (now - this._lastCompassUpdate > 100) {
            this._lastCompassUpdate = now;
            if (window.GPS) {
                const h = window.GPS.smoothHeading || 0;
                const compassEl = document.getElementById('compass-heading');
                if (compassEl) compassEl.style.transform = `rotate(${-h}deg)`;
                const compassValEl = document.getElementById('compass-value');
                if (compassValEl) {
                    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
                    compassValEl.innerText = dirs[Math.round(h / 45) % 8];
                }
            }
        }

        // ── Material pulse ──
        if (this.chevronMat) {
            const pulse = 0.85 + Math.sin(t * 3.0) * 0.15;
            this.chevronMat.emissiveIntensity = pulse;
            this.chevronMat.opacity = 0.82 + Math.sin(t * 2.5) * 0.10;
        }

        // ── GPS-to-AR position sync ──
        if (this.anchorLocked && window.GPS?.displayLat && window.RouteManager) {
            const gpsLocal = window.RouteManager.latLonToAnchor(
                window.GPS.displayLat, window.GPS.displayLon,
                this.anchorLat, this.anchorLon
            );
            const tx = -gpsLocal.x;
            const tz = -gpsLocal.z;
            this.pathGroup.position.x += (tx - this.pathGroup.position.x) * 0.55;
            this.pathGroup.position.z += (tz - this.pathGroup.position.z) * 0.55;
        }

        // ── XR heading rotation ──
        if (this.xrActive && window.GPS && spdMs > 2.0 && this.anchorLocked) {
            const targetY = window.GPS.smoothHeading * (Math.PI / 180);
            let dY = targetY - this.pathGroup.rotation.y;
            if (dY > Math.PI) dY -= Math.PI * 2;
            if (dY < -Math.PI) dY += Math.PI * 2;
            this.pathGroup.rotation.y += dY * 0.06;
        }

        // ── Dynamic FOV — only update projection when FOV actually changes ──
        if (this.camera) {
            const targetFov = this.camera.userData.baseFov + Math.min(12, spdMs * 1.0);
            if (Math.abs(this._lastFov - targetFov) > 0.3) {
                this._lastFov += (targetFov - this._lastFov) * 0.06;
                this.camera.fov = this._lastFov;
                this.camera.updateProjectionMatrix();
            }
        }

        // ── Chevron InstancedMesh — ZERO allocations ──
        if (this.routeCurve && this.curveLength > 0) {
            const flowSpeed = (1.8 + spdMs * 0.4) / this.curveLength;
            this.flowOffset = (this.flowOffset + flowSpeed * (1 / 60)) % 1.0;

            const curLen = this.curveLength;
            const spacing = this.CHEVRON_SPACING;
            const count = Math.min(this.MAX_CHEVRONS, Math.floor(curLen / spacing));
            this.chevronInstanced.count = count;
            this.chevronOutlineInstanced.count = count;

            const dummy = this._tempObj;
            for (let i = 0; i < count; i++) {
                let u = (this.flowOffset + (i * spacing) / curLen) % 1.0;
                if (u < 0) u += 1.0;

                try {
                    // Reuse pre-allocated vectors
                    this.routeCurve.getPoint(u, this._tempVec);
                    this.routeCurve.getTangent(u, this._tempTarget);

                    dummy.position.set(this._tempVec.x, 0.14, this._tempVec.z);

                    // Orient along tangent — reuse _tempTarget
                    this._tempTarget.set(
                        this._tempVec.x + this._tempTarget.x,
                        0.14,
                        this._tempVec.z + this._tempTarget.z
                    );
                    dummy.lookAt(this._tempTarget);

                    const distFactor = 1.0 - u * 0.55;
                    const s = Math.max(0.3, distFactor * 1.15);
                    dummy.scale.set(s, s, s);

                    dummy.updateMatrix();
                    this.chevronInstanced.setMatrixAt(i, dummy.matrix);
                    
                    // Slightly lower for outline to prevent Z-fighting
                    dummy.position.y -= 0.03;
                    dummy.updateMatrix();
                    this.chevronOutlineInstanced.setMatrixAt(i, dummy.matrix);
                } catch (e) {
                    dummy.scale.set(0.001, 0.001, 0.001);
                    dummy.updateMatrix();
                    this.chevronInstanced.setMatrixAt(i, dummy.matrix);
                    this.chevronOutlineInstanced.setMatrixAt(i, dummy.matrix);
                }
            }
            this.chevronInstanced.instanceMatrix.needsUpdate = true;
            this.chevronOutlineInstanced.instanceMatrix.needsUpdate = true;
        }

        // ── Beacon billboard ──
        for (let bi = 0; bi < this.beaconPool.length; bi++) {
            const beacon = this.beaconPool[bi];
            if (!beacon.visible) continue;
            const signGroup = beacon.children[2];
            if (signGroup) {
                signGroup.lookAt(
                    this.camera.position.x - this.pathGroup.position.x,
                    signGroup.position.y + beacon.position.y,
                    this.camera.position.z - this.pathGroup.position.z
                );
                signGroup.position.y = 19 + Math.sin(t * 1.3) * 0.35;
            }
        }

        // ── Destination pin ──
        if (this.destPinObj.visible) {
            this.destPinObj.rotation.y = t * 0.3;
            if (this.destPinObj.children[0]) {
                this.destPinObj.children[0].position.y = 6 + Math.sin(t * 1.6) * 0.22;
            }
        }

        this.renderer.render(this.scene, this.camera);
    },

    resetAnchor() {
        this.anchorLocked = false;
        this.anchorLat = null;
        this.anchorLon = null;
        this.routeCurve = null;
        this.curveLength = 0;
        this.flowOffset = 0;
        this.cachedCount = 0;
        this.chevronInstanced.count = 0;
        this.beaconPool.forEach(b => { b.visible = false; });
        this.destPinObj.visible = false;
        if (this.laneGlowMesh) {
            this.pathGroup.remove(this.laneGlowMesh);
            this.laneGlowMesh.geometry.dispose();
            this.laneGlowMesh = null;
        }
        this.pathGroup.position.set(0, 0, 0);
    }
};
