const { spawn } = require('child_process');

function startTunnel() {
    console.log("Starting secure tunnel...");
    // Force a specific subdomain so it never changes on you
    const lt = spawn('npx', ['localtunnel', '--port', '3000', '--subdomain', 'astradrive'], { shell: true });
    
    lt.stdout.on('data', data => console.log(data.toString().trim()));
    lt.stderr.on('data', data => {});
    
    lt.on('close', code => {
        console.log("Tunnel dropped - Auto-reconnecting...");
        setTimeout(startTunnel, 1000);
    });
}

startTunnel();
