// ==UserScript==
// @name         Dual-Layer Network & Memory Diagnostic Monitor
// @namespace    http://tampermonkey.net
// @version      2.2
// @description  Network and runtime diagnostic monitor with an about:blank packet viewer.
// @author       Educational Researcher
// @match        *://suroi.io/*
// @match        *://*.suroi.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    console.log(
        "%c[SYSTEM] Starting Diagnostic Pipeline...",
        "color: #ff00ff; font-weight: bold; font-size: 14px;"
    );

    // ==========================================
    // PACKET STORAGE
    // ==========================================

    const capturedPackets = [];
    let packetNumber = 0;
    let viewerWindow = null;

    // ==========================================
    // MEMORY-OBJECT SCANNING
    // ==========================================

    const trackedObjects = {
        gameEngine: null,
        inputManager: null,
        camera: null,
        minimap: null,
        ui: null
    };

    function probeMemoryObject(obj, discoverySource) {
        if (!obj || typeof obj !== 'object') return;

        if (
            !trackedObjects.gameEngine &&
            (
                obj.activePlayerID !== undefined ||
                (obj.pixi && obj.pixi.stage)
            )
        ) {
            trackedObjects.gameEngine = obj;

            console.log(
                `[MEMORY] Captured Game Engine reference via ${discoverySource}!`
            );
        }

        if (
            !trackedObjects.inputManager &&
            obj.attacking !== undefined &&
            obj.rotation !== undefined &&
            obj.movement
        ) {
            trackedObjects.inputManager = obj;

            console.log(
                `[MEMORY] Captured Input Manager reference via ${discoverySource}!`
            );
        }

        if (
            !trackedObjects.camera &&
            obj.zoom !== undefined &&
            obj.position &&
            obj.container &&
            obj.container.scale
        ) {
            trackedObjects.camera = obj;

            console.log(
                `[MEMORY] Captured Camera reference via ${discoverySource}!`
            );
        }

        if (
            !trackedObjects.minimap &&
            (
                obj._minimapWidth !== undefined ||
                obj.minimapWidth !== undefined
            )
        ) {
            trackedObjects.minimap = obj;

            console.log(
                `[MEMORY] Captured Minimap reference via ${discoverySource}!`
            );
        }

        if (
            !trackedObjects.ui &&
            obj.inventory &&
            (obj.killLeaderCache || obj.uiContainer)
        ) {
            trackedObjects.ui = obj;

            console.log(
                `[MEMORY] Captured UI Manager reference via ${discoverySource}!`
            );
        }
    }

    const originalBind = Function.prototype.bind;

    Function.prototype.bind = function (context, ...args) {
        probeMemoryObject(context, "Function.bind");

        return originalBind.call(
            this,
            context,
            ...args
        );
    };

    const originalRAF = window.requestAnimationFrame;

    window.requestAnimationFrame = function (callback) {
        if (
            callback &&
            typeof callback === 'object' &&
            callback.handleEvent
        ) {
            probeMemoryObject(
                callback,
                "requestAnimationFrame"
            );
        }

        return originalRAF.call(
            this,
            callback
        );
    };

    const originalAddEventListener =
        EventTarget.prototype.addEventListener;

    EventTarget.prototype.addEventListener =
        function (type, listener, options) {

            if (
                listener &&
                typeof listener === 'object' &&
                listener.handleEvent
            ) {
                probeMemoryObject(
                    listener,
                    "addEventListener"
                );
            }

            return originalAddEventListener.call(
                this,
                type,
                listener,
                options
            );
        };


    // ==========================================
    // ABOUT:BLANK VIEWER
    // ==========================================

    function openPacketViewer() {

        // If the window already exists, focus it.
        if (
            viewerWindow &&
            !viewerWindow.closed
        ) {
            viewerWindow.focus();
            refreshViewer();
            return;
        }

        /*
         * Open synchronously from the button click.
         * This is important because browsers may block
         * windows opened asynchronously.
         */
        viewerWindow = window.open(
            'about:blank',
            '_blank',
            'width=1400,height=900,resizable=yes,scrollbars=yes'
        );

        if (!viewerWindow) {
            alert(
                'The packet viewer was blocked by the browser. ' +
                'Allow pop-ups for this site and try again.'
            );

            return;
        }

        buildViewerDocument();

        viewerWindow.focus();
    }


    function buildViewerDocument() {

        const doc = viewerWindow.document;

        doc.open();

        doc.write(`
<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<title>WebSocket Packet Viewer</title>

<style>

* {
    box-sizing: border-box;
}

html,
body {
    margin: 0;
    padding: 0;

    width: 100%;
    height: 100%;

    background: #050505;
    color: #ddd;

    font-family:
        Consolas,
        Monaco,
        "Courier New",
        monospace;
}

body {
    overflow: hidden;
}

#header {
    height: 58px;

    display: flex;
    align-items: center;

    padding: 0 16px;

    background: #101010;

    border-bottom: 1px solid #303030;
}

#title {
    color: #00ffff;

    font-size: 16px;

    font-weight: bold;
}

#count {
    color: #777;

    margin-left: 12px;

    font-size: 12px;
}

#controls {
    margin-left: auto;

    display: flex;

    gap: 8px;
}

button {
    background: #191919;

    color: #ddd;

    border: 1px solid #444;

    border-radius: 4px;

    padding: 7px 12px;

    font-family: inherit;

    cursor: pointer;
}

button:hover {
    background: #292929;
}

#table-container {
    height: calc(100vh - 58px);

    overflow: auto;
}

table {
    width: 100%;

    border-collapse: collapse;

    table-layout: fixed;
}

thead {
    position: sticky;

    top: 0;

    z-index: 2;

    background: #161616;
}

th {
    padding: 9px;

    text-align: left;

    color: #888;

    border-bottom: 1px solid #333;

    font-size: 11px;
}

td {
    padding: 8px;

    vertical-align: top;

    border-bottom: 1px solid #202020;

    font-size: 11px;
}

tr:hover {
    background: #111;
}

.number {
    width: 70px;
    color: #777;
}

.direction {
    width: 105px;
    font-weight: bold;
}

.inbound {
    color: #4ade80;
}

.outbound {
    color: #f87171;
}

.time {
    width: 180px;
    color: #777;
}

.size {
    width: 80px;
    color: #00ffff;
}

.byte0 {
    width: 80px;
    color: #ff9f43;
}

.hex {
    width: auto;
    color: #ddd;

    white-space: pre-wrap;

    word-break: break-all;

    line-height: 1.5;
}

.ascii {
    width: 260px;

    color: #888;

    white-space: pre-wrap;

    word-break: break-all;
}

.copy-cell {
    width: 70px;
}

.copy-button {
    padding: 4px 7px;

    font-size: 10px;
}

.empty {
    text-align: center;

    padding: 60px;

    color: #555;
}

</style>

</head>

<body>

<div id="header">

    <div id="title">
        WebSocket Packet Viewer
    </div>

    <div id="count">
        0 packets
    </div>

    <div id="controls">

        <button id="copyAll">
            Copy All
        </button>

        <button id="clear">
            Clear
        </button>

    </div>

</div>

<div id="table-container">

<table>

<thead>

<tr>

<th class="number">
    #
</th>

<th class="direction">
    Direction
</th>

<th class="time">
    Time
</th>

<th class="size">
    Size
</th>

<th class="byte0">
    Byte 0
</th>

<th class="hex">
    Full Packet (HEX)
</th>

<th class="ascii">
    ASCII
</th>

<th class="copy-cell">
    Copy
</th>

</tr>

</thead>

<tbody id="packets">

</tbody>

</table>

</div>

</body>

</html>
        `);

        doc.close();

        doc.getElementById('copyAll')
            .addEventListener(
                'click',
                copyAllPackets
            );

        doc.getElementById('clear')
            .addEventListener(
                'click',
                clearPackets
            );

        refreshViewer();
    }


    // ==========================================
    // FORMAT HELPERS
    // ==========================================

    function bytesToHex(bytes) {

        return Array.from(bytes)
            .map(
                byte =>
                    byte
                        .toString(16)
                        .padStart(2, '0')
                        .toUpperCase()
            )
            .join(' ');
    }


    function bytesToAscii(bytes) {

        return Array.from(bytes)
            .map(byte => {

                if (
                    byte >= 32 &&
                    byte <= 126
                ) {
                    return String.fromCharCode(byte);
                }

                return '.';
            })
            .join('');
    }


    function createRawPacketText(packet) {

        return [
            '========================================',
            `PACKET #${packet.number}`,
            `Time:      ${packet.time}`,
            `Direction: ${packet.direction}`,
            `Type:      ${packet.type}`,
            `Size:      ${packet.bytes.length} bytes`,
            `Byte 0:    ${
                packet.bytes.length
                    ? '0x' +
                      packet.bytes[0]
                        .toString(16)
                        .padStart(2, '0')
                        .toUpperCase()
                    : 'N/A'
            }`,
            '',
            'HEX:',
            bytesToHex(packet.bytes),
            '',
            'ASCII:',
            bytesToAscii(packet.bytes),
            '========================================'
        ].join('\n');
    }


    // ==========================================
    // VIEWER REFRESH
    // ==========================================

    function refreshViewer() {

        if (
            !viewerWindow ||
            viewerWindow.closed
        ) {
            return;
        }

        const doc = viewerWindow.document;

        const tbody =
            doc.getElementById('packets');

        if (!tbody) return;

        tbody.innerHTML = '';

        for (
            const packet of capturedPackets
        ) {

            const row =
                doc.createElement('tr');

            const number =
                doc.createElement('td');

            number.className = 'number';

            number.textContent =
                `#${packet.number}`;


            const direction =
                doc.createElement('td');

            direction.className =
                'direction ' +
                (
                    packet.direction === 'INBOUND'
                        ? 'inbound'
                        : 'outbound'
                );

            direction.textContent =
                packet.direction;


            const time =
                doc.createElement('td');

            time.className = 'time';

            time.textContent =
                packet.time;


            const size =
                doc.createElement('td');

            size.className = 'size';

            size.textContent =
                `${packet.bytes.length} B`;


            const byte0 =
                doc.createElement('td');

            byte0.className = 'byte0';

            byte0.textContent =
                packet.bytes.length
                    ? '0x' +
                      packet.bytes[0]
                        .toString(16)
                        .padStart(2, '0')
                        .toUpperCase()
                    : 'N/A';


            const hex =
                doc.createElement('td');

            hex.className = 'hex';

            hex.textContent =
                bytesToHex(packet.bytes);


            const ascii =
                doc.createElement('td');

            ascii.className = 'ascii';

            ascii.textContent =
                bytesToAscii(packet.bytes);


            const copyCell =
                doc.createElement('td');

            copyCell.className =
                'copy-cell';


            const copyButton =
                doc.createElement('button');

            copyButton.className =
                'copy-button';

            copyButton.textContent =
                'Copy';


            copyButton.addEventListener(
                'click',
                async function () {

                    try {

                        await navigator.clipboard
                            .writeText(
                                createRawPacketText(
                                    packet
                                )
                            );

                        copyButton.textContent =
                            'Copied';

                        setTimeout(
                            () => {
                                copyButton.textContent =
                                    'Copy';
                            },
                            1000
                        );

                    } catch (error) {

                        console.error(
                            '[PACKET] Clipboard error:',
                            error
                        );

                    }

                }
            );


            copyCell.appendChild(
                copyButton
            );


            row.appendChild(number);
            row.appendChild(direction);
            row.appendChild(time);
            row.appendChild(size);
            row.appendChild(byte0);
            row.appendChild(hex);
            row.appendChild(ascii);
            row.appendChild(copyCell);

            tbody.appendChild(row);
        }


        const count =
            doc.getElementById('count');

        if (count) {

            count.textContent =
                `${capturedPackets.length} packet` +
                (
                    capturedPackets.length === 1
                        ? ''
                        : 's'
                );
        }
    }


    // ==========================================
    // COPY ALL
    // ==========================================

    async function copyAllPackets() {

        if (
            !viewerWindow ||
            viewerWindow.closed
        ) {
            return;
        }

        const output =
            capturedPackets
                .map(createRawPacketText)
                .join('\n\n');

        if (!output) return;

        try {

            await viewerWindow.navigator
                .clipboard.writeText(output);

        } catch {

            /*
             * Clipboard permissions can differ between
             * about:blank windows and the parent page.
             *
             * Fallback to the parent window.
             */

            try {

                await navigator.clipboard
                    .writeText(output);

            } catch (error) {

                console.error(
                    '[PACKET] Clipboard error:',
                    error
                );

            }
        }
    }


    // ==========================================
    // CLEAR
    // ==========================================

    function clearPackets() {

        capturedPackets.length = 0;

        packetNumber = 0;

        refreshViewer();
    }


    // ==========================================
    // PACKET CAPTURE
    // ==========================================

    function capturePacket(
        data,
        direction,
        type
    ) {

        const bytes =
            new Uint8Array(data);

        const packet = {

            number: ++packetNumber,

            time:
                new Date()
                    .toISOString(),

            direction,

            type,

            bytes:
                new Uint8Array(bytes)
        };

        capturedPackets.push(packet);

        console.log(
            `[${direction}] Captured ${bytes.length} bytes`
        );

        /*
         * If the viewer is already open, update it
         * immediately.
         */

        refreshViewer();
    }


    function logNetworkData(
        data,
        direction
    ) {

        if (
            typeof data === 'string'
        ) {

            const encoder =
                new TextEncoder();

            const bytes =
                encoder.encode(data);

            capturePacket(
                bytes.buffer,
                direction,
                'String'
            );

            return;
        }


        if (
            data instanceof ArrayBuffer
        ) {

            capturePacket(
                data,
                direction,
                'ArrayBuffer'
            );

            return;
        }


        if (
            data instanceof Blob
        ) {

            data.arrayBuffer()
                .then(buffer => {

                    capturePacket(
                        buffer,
                        direction,
                        'Blob'
                    );

                })
                .catch(error => {

                    console.error(
                        '[PACKET] Blob error:',
                        error
                    );

                });

            return;
        }


        console.log(
            `[${direction}] Unknown WebSocket data type:`,
            data
        );
    }


    // ==========================================
    // WEBSOCKET MONITOR
    // ==========================================

    const AuthenticWebSocket =
        window.WebSocket;

    const MonitoredWebSocket =
        function (url, protocols) {

            const socket =
                arguments.length > 1
                    ? new AuthenticWebSocket(
                        url,
                        protocols
                    )
                    : new AuthenticWebSocket(
                        url
                    );


            console.log(
                `%c[NETWORK] Connected Pipe -> ${url}`,
                "color: #00ffff;"
            );


            // INBOUND

            socket.addEventListener(
                'message',
                function (event) {

                    logNetworkData(
                        event.data,
                        'INBOUND'
                    );

                }
            );


            // OUTBOUND

            const realSend =
                socket.send;

            Object.defineProperty(
                socket,
                'send',
                {
                    configurable: true,
                    writable: true,
                    enumerable: false,

                    value:
                        function (payload) {

                            logNetworkData(
                                payload,
                                'OUTBOUND'
                            );

                            return realSend.apply(
                                this,
                                arguments
                            );
                        }
                }
            );


            return socket;
        };


    MonitoredWebSocket.prototype =
        AuthenticWebSocket.prototype;

    Object.setPrototypeOf(
        MonitoredWebSocket,
        AuthenticWebSocket
    );


    Object.defineProperty(
        window,
        'WebSocket',
        {
            value:
                MonitoredWebSocket,

            configurable: true,

            writable: true,

            enumerable: false
        }
    );


    // ==========================================
    // VIEWER BUTTON
    // ==========================================

    function createOpenButton() {

        const button =
            document.createElement('button');

        button.textContent =
            'Open Packet Viewer';

        button.title =
            'Open captured WebSocket packets';

        button.style.cssText = `
            position: fixed;
            top: 10px;
            left: 10px;

            z-index: 2147483647;

            background: #050505;
            color: #00ffff;

            border: 1px solid #444;
            border-radius: 5px;

            padding: 8px 12px;

            font-family:
                Consolas,
                Monaco,
                "Courier New",
                monospace;

            font-size: 12px;

            cursor: pointer;

            box-shadow:
                0 3px 12px rgba(0,0,0,.5);
        `;

        button.addEventListener(
            'mouseenter',
            () => {
                button.style.background =
                    '#181818';
            }
        );

        button.addEventListener(
            'mouseleave',
            () => {
                button.style.background =
                    '#050505';
            }
        );

        button.addEventListener(
            'click',
            openPacketViewer
        );

        document.documentElement
            .appendChild(button);
    }


    /*
     * document-start means <body> might not exist yet,
     * so wait until the document has an element we can
     * safely attach the button to.
     */

    if (
        document.documentElement
    ) {
        createOpenButton();
    } else {

        document.addEventListener(
            'DOMContentLoaded',
            createOpenButton,
            {
                once: true
            }
        );
    }

})();
