// ai-worker.js — Off-Main-Thread AI Object Detection v2
// Lazy-loads TF.js only when first detection requested — saves 5MB on init
// Uses WASM backend to avoid competing with Three.js for WebGL context

let model = null;
let loading = false;

async function loadModel() {
    if (model || loading) return;
    loading = true;
    try {
        importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js');
        // Prefer WASM to avoid WebGL context contention with Three.js
        try {
            importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.10.0/dist/tf-backend-wasm.min.js');
            await tf.setBackend('wasm');
        } catch (e) {
            // Fallback to CPU if WASM unavailable
            try { await tf.setBackend('webgl'); } catch (e2) { await tf.setBackend('cpu'); }
        }
        importScripts('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
        model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
        postMessage({ type: 'ready' });
    } catch (err) {
        postMessage({ type: 'error', error: 'Model load failed: ' + err.message });
        loading = false;
    }
}

onmessage = async (e) => {
    if (e.data.type === 'init') {
        await loadModel();
        return;
    }
    if (e.data.type !== 'detect') return;

    // Lazy-load on first detection request
    if (!model) {
        await loadModel();
        if (!model) {
            postMessage({ type: 'error', error: 'Model not loaded' });
            return;
        }
    }

    try {
        const preds = await model.detect(e.data.image);
        postMessage({ type: 'result', preds });
    } catch (err) {
        postMessage({ type: 'error', error: err.message });
    }
};
