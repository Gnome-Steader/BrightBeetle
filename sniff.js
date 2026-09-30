Cheat
// ==UserScript==
// @name         Dual-Layer Network & Memory Diagnostic Monitor
// @namespace    http://tampermonkey.net
// @version      2.0
// @description  Combines stealth network gateway culling with runtime memory-object probing for full stack diagnostics.
// @author       Educational Researcher
// @match        *://suroi.io/*
// @match        *://*.suroi.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log("%c[SYSTEM] Starting Dual-Layer Diagnostic Pipeline...", "color: #ff00ff; font-weight: bold; font-size: 14px;");

    // ==========================================
    // LAYER 1: MEMORY-OBJECT SCANNING LOGIC
    // ==========================================
    let trackedObjects = {
        gameEngine: null,
        inputManager: null,
        camera: null,
        minimap: null,
        ui: null
    };

    function probeMemoryObject(obj, discoverySource) {
        if (!obj || typeof obj !== 'object') return;
        
        // Probe for Game Engine/Pixi signatures
        if (!trackedObjects.gameEngine && (obj.activePlayerID !== undefined || (obj.pixi && obj.pixi.stage))) {
            trackedObjects.gameEngine = obj;
            console.log(`%c[MEMORY] Captured Game Engine reference via ${discoverySource}!`, "color: #bfff00; font-weight: bold;");
        }
        // Probe for Input parameters
        if (!trackedObjects.inputManager && (obj.attacking !== undefined && obj.rotation !== undefined && obj.movement)) {
            trackedObjects.inputManager = obj;
            console.log(`%c[MEMORY] Captured Input Manager reference via ${discoverySource}!`, "color: #bfff00; font-weight: bold;");
        }
        // Probe for Camera boundaries
        if (!trackedObjects.camera && (obj.zoom !== undefined && obj.position && obj.container && obj.container.scale)) {
            trackedObjects.camera = obj;
            console.log(`%c[MEMORY] Captured Camera reference via ${discoverySource}!`, "color: #bfff00; font-weight: bold;");
        }
        // Probe for Map frameworks
        if (!trackedObjects.minimap && (obj._minimapWidth !== undefined || obj.minimapWidth !== undefined)) {
            trackedObjects.minimap = obj;
            console.log(`%c[MEMORY] Captured Minimap reference via ${discoverySource}!`, "color: #bfff00; font-weight: bold;");
        }
        // Probe for UI cache maps
        if (!trackedObjects.ui && (obj.inventory && (obj.killLeaderCache || obj.uiContainer))) {
            trackedObjects.ui = obj;
            console.log(`%c[MEMORY] Captured UI Manager reference via ${discoverySource}!`, "color: #bfff00; font-weight: bold;");
        }
    }

    // Safely install memory hooks onto standard browser execution pipelines
    const originalBind = Function.prototype.bind;
    Function.prototype.bind = function(context, ...args) { 
        probeMemoryObject(context, "Function.bind"); 
        return originalBind.call(this, context, ...args); 
    };
    
    const originalRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function(callback) { 
        if (callback && typeof callback === 'object' && callback.handleEvent) {
            probeMemoryObject(callback, "requestAnimationFrame"); 
        }
        return originalRAF.call(this, callback); 
    };

    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) { 
        if (listener && typeof listener === 'object' && listener.handleEvent) {
            probeMemoryObject(listener, "addEventListener"); 
        }
        return originalAddEventListener.call(this, type, listener, options); 
    };


    // ==========================================
    // LAYER 2: STEALTH NETWORK GATEWAY LOGIC
    // ==========================================
    const AuthenticWebSocket = window.WebSocket;
    const nativeToString = Function.prototype.toString;

    const StealthWebSocket = function(url, protocols) {
        const socket = arguments.length > 1 
            ? new AuthenticWebSocket(url, protocols) 
            : new AuthenticWebSocket(url);

        console.log(`%c[NETWORK] Connected Pipe -> ${url}`, "color: #00ffff;");

        // Listen passively to inbound server payloads
        socket.addEventListener('message', function(event) {
            logNetworkData(event.data, 'INBOUND');
        });

        // Listen passively to outbound client payloads
        const realSend = socket.send;
        Object.defineProperty(socket, 'send', {
            configurable: true, writable: true, enumerable: false,
            value: function(payload) {
                logNetworkData(payload, 'OUTBOUND');
                return realSend.apply(this, arguments);
            }
        });

        return socket;
    };

    // Protect network hooks from integrity verification loops
    StealthWebSocket.prototype = AuthenticWebSocket.prototype;
    Object.setPrototypeOf(StealthWebSocket, AuthenticWebSocket);
    Object.defineProperty(StealthWebSocket.prototype, 'constructor', {
        value: StealthWebSocket, configurable: true, writable: true, enumerable: false
    });

    Function.prototype.toString = function() {
        if (this === StealthWebSocket) return "function WebSocket() { [native code] }";
        return nativeToString.apply(this, arguments);
    };

    Object.defineProperty(window, 'WebSocket', {
        value: StealthWebSocket, configurable: true, writable: true, enumerable: false
    });


    // ==========================================
    // PARSING & LOG FORMATTING INFRASTRUCTURE
    // ==========================================
    function logNetworkData(data, direction) {
        const dirColor = direction === 'INBOUND' ? '#28a745' : '#dc3545';
        
        if (typeof data === 'string') {
            console.log(`%c[${direction}] Text ->`, `color: ${dirColor}; font-weight: bold;`, data);
            return;
        }

        if (data instanceof ArrayBuffer || data instanceof Blob) {
            if (data instanceof Blob) {
                data.arrayBuffer().then(buf => processHexPrint(buf, direction, dirColor));
            } else {
                processHexPrint(data, direction, dirColor);
            }
        }
    }

    function processHexPrint(buffer, direction, consoleColor) {
        const view = new DataView(buffer);
        const packetId = buffer.byteLength > 0 ? view.getUint8(0) : '0';
        
        const bytes = new Uint8Array(buffer);
        const hexStr = [];
        for (let i = 0; i < Math.min(bytes.length, 16); i++) {
            let h = bytes[i].toString(16).toUpperCase();
            if (h.length < 2) h = '0' + h;
            hexStr.push(h);
        }

        console.log(
            `%c[${direction}] %cSize: %c${buffer.byteLength}B %c| Opcode: %c${packetId} %c| Hex: [ %c${hexStr.join(' ')}${bytes.length > 16 ? '...' : ''} %c]`,
            `color: ${consoleColor}; font-weight: bold;`,
            `color: #ffffff;`,
            `color: #00ffff; font-weight: bold;`,
            `color: #ffffff;`,
            `color: #ff8c00; font-weight: bold;`,
            `color: #ffffff;`,
            `color: #888888; font-style: italic;`,
            `color: #ffffff;`
        );
    }
})();
