// ai-worker.js — Off-Main-Thread AI Object Detection
importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js');
importScripts('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');

let model = null;

tf.setBackend('webgl').then(() => {
    // Try to init webgl for fast GPU processing in worker if supported by browser
}).catch(() => {
    tf.setBackend('cpu');
});

cocoSsd.load({ base: 'lite_mobilenet_v2' }).then(m => {
    model = m;
    postMessage({ type: 'ready' });
});

onmessage = async (e) => {
    if (!model || e.data.type !== 'detect') return;
    try {
        const imageData = e.data.image;
        // tf.browser.fromPixels accepts ImageData
        const preds = await model.detect(imageData);
        postMessage({ type: 'result', preds: preds });
    } catch(err) {
        postMessage({ type: 'error', error: err.message });
    }
};
