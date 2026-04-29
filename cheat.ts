/**
 * Suroi Aimbot + ESP Console Cheat
 *
 * HOW TO USE:
 *   1. Open suroi in your browser
 *   2. Open DevTools console (F12 → Console)
 *   3. Paste this ENTIRE script and press Enter
 *   4. Join a game — the cheat activates automatically
 *
 * CONTROLS:
 *   F1  → Toggle ESP on/off
 *   F2  → Toggle Aimbot on/off
 *   F3  → Toggle Aimbot lines (show aim target)
 *   F4  → Cycle ESP mode: Box+Tracer → Box only → Tracer only
 *
 * FEATURES:
 *   🎯 AIMBOT  — auto-aims at nearest enemy by modifying outgoing rotation
 *   👁️ ESP     — player boxes, tracers, health bars, names drawn on overlay
 *   📦 LOOT ESP — shows nearby loot items
 */
(() => {
    "use strict";

    // ═══════════════════════════════════════════════════════════════════════
    //  CONFIG
    // ═══════════════════════════════════════════════════════════════════════
    const CFG = {
        esp: {
            enabled:      true,
            boxes:        true,     // draw boxes around enemies
            tracers:      true,     // draw lines from bottom-center to enemies
            health:       true,     // health bars above enemies
            names:        true,     // player names
            loot:         true,     // show loot on ground
            lootRange:    150,      // max range to show loot (game units)
            enemyColor:   "#ff2040",
            teamColor:    "#00ff80",
            lootColor:    "#ffaa00",
            deadColor:    "#666666",
        },
        aimbot: {
            enabled:      true,
            showLine:     true,     // draw aim line
            fov:          360,      // field of view in degrees (360 = lock all)
            smooth:       1.0,      // 1.0 = instant snap, lower = smoother
            maxRange:     500,      // max targeting range (game units)
            lineColor:    "#ff00ff",
        },
    };

    // ═══════════════════════════════════════════════════════════════════════
    //  PROTOCOL CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    const TAU = Math.PI * 2;
    const MAX_POS = 1924;
    const MAX_MOUSE_DIST = 256;
    const PIXI_SCALE = 20;

    // Packet types (from common/src/packets/packet.ts)
    const PKT_UPDATE = 2;   // PacketType.Update (server → client)
    const PKT_INPUT  = 0;   // PacketType.Input  (client → server)

    // ObjectCategory enum values
    const CAT_PLAYER   = 0;
    const CAT_OBSTACLE = 1;
    const CAT_LOOT     = 3;

    // ═══════════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════════

    /** Tracked player state */
    interface TrackedPlayer {
        x: number; y: number;
        rotation: number;
        dead: boolean;
        teamId: number;
        name: string;
        health: number;     // 0-1
        downed: boolean;
    }

    const players = new Map<number, TrackedPlayer>();
    const lootItems = new Map<number, { x: number; y: number; name: string }>();

    let myId     = -1;
    let myX      = 0;
    let myY      = 0;
    let myTeamId = -1;

    // Camera state (we track via pixi container)
    let camScale = 1;
    let camX     = 0;
    let camY     = 0;

    // Aimbot target
    let aimTargetX = 0;
    let aimTargetY = 0;
    let hasAimTarget = false;
    let aimAngle     = 0;

    // Game WebSocket reference
    let gameWs: WebSocket | null = null;

    // ═══════════════════════════════════════════════════════════════════════
    //  BYTE STREAM READER (minimal reimplementation)
    // ═══════════════════════════════════════════════════════════════════════
    class MiniReader {
        private _view: DataView;
        private _idx = 0;

        constructor(buf: ArrayBuffer) {
            this._view = new DataView(buf);
        }

        get index() { return this._idx; }
        get remaining() { return this._view.byteLength - this._idx; }

        u8(): number  { const v = this._view.getUint8(this._idx); this._idx += 1; return v; }
        u16(): number { const v = this._view.getUint16(this._idx, true); this._idx += 2; return v; }
        u32(): number { const v = this._view.getUint32(this._idx, true); this._idx += 4; return v; }
        i8(): number  { const v = this._view.getInt8(this._idx); this._idx += 1; return v; }
        f32(): number { const v = this._view.getFloat32(this._idx, true); this._idx += 4; return v; }

        skip(n: number) { this._idx += n; }

        readPosition(): { x: number; y: number } {
            return {
                x: MAX_POS * this.u16() / 65535,
                y: MAX_POS * this.u16() / 65535,
            };
        }

        readRotation2(): number {
            return TAU * (this.u16() / 65535 - 0.5);
        }

        readFloat01_2(): number {
            return this.u16() / 65535;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  BYTE STREAM WRITER (for modifying outgoing packets)
    // ═══════════════════════════════════════════════════════════════════════
    function writeRotation2(angle: number): number {
        // Returns the uint16 value for a rotation
        return Math.round((angle / TAU + 0.5) * 65535) & 0xFFFF;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CANVAS OVERLAY (for ESP drawing)
    // ═══════════════════════════════════════════════════════════════════════
    const overlay = document.createElement("canvas");
    overlay.id = "cheat-overlay";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        pointer-events: none; z-index: 999999;
    `;
    document.body.appendChild(overlay);
    const ctx = overlay.getContext("2d")!;

    function resizeOverlay() {
        overlay.width  = window.innerWidth;
        overlay.height = window.innerHeight;
    }
    resizeOverlay();
    window.addEventListener("resize", resizeOverlay);

    // Status HUD
    const hud = document.createElement("div");
    hud.id = "cheat-hud";
    hud.style.cssText = `
        position: fixed; top: 8px; left: 8px; z-index: 9999999;
        font: bold 13px monospace; color: #0f0; background: rgba(0,0,0,0.6);
        padding: 6px 10px; border-radius: 4px; pointer-events: none;
        text-shadow: 1px 1px 2px #000; line-height: 1.5;
    `;
    document.body.appendChild(hud);

    function updateHud() {
        const lines = [
            `[F1] ESP:    ${CFG.esp.enabled ? "ON" : "OFF"}`,
            `[F2] Aimbot: ${CFG.aimbot.enabled ? "ON" : "OFF"}`,
            `[F3] AimLine:${CFG.aimbot.showLine ? "ON" : "OFF"}`,
            `[F4] Mode:   ${CFG.esp.boxes && CFG.esp.tracers ? "ALL" : CFG.esp.boxes ? "BOX" : "TRACER"}`,
            `Players: ${players.size} | WS: ${gameWs ? "✓" : "✗"}`,
        ];
        hud.innerHTML = lines.map(l => `<div>${l}</div>`).join("");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  COORDINATE CONVERSION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Convert game-world position to screen position.
     * We track camera transforms by reading the pixi container if available,
     * or by estimating from our own position.
     */
    function worldToScreen(wx: number, wy: number): { sx: number; sy: number } {
        // Try to read camera from the game's pixi container
        updateCameraFromDOM();

        const screenCenterX = overlay.width  / 2;
        const screenCenterY = overlay.height / 2;

        // World → pixi coords (multiply by PIXI_SCALE)
        const px = wx * PIXI_SCALE;
        const py = wy * PIXI_SCALE;

        // Camera centers on our position
        const myPx = myX * PIXI_SCALE;
        const myPy = myY * PIXI_SCALE;

        // Screen offset
        const sx = screenCenterX + (px - myPx) * camScale;
        const sy = screenCenterY + (py - myPy) * camScale;

        return { sx, sy };
    }

    function updateCameraFromDOM() {
        // Try to find the pixi container and read its scale
        try {
            const gameCanvas = document.querySelector("canvas") as HTMLCanvasElement | null;
            if (!gameCanvas) return;

            // The game's pixi container applies a scale transform
            // We can estimate from window size and scope zoom level
            const maxDim = Math.max(overlay.width, overlay.height);
            // Default scope is 48 (1x), max is ~120 (15x)
            // Scale ≈ maxDim / (2 * zoomLevel * PIXI_SCALE)
            // We approximate; the exact value comes from the game's CameraManager
            if (camScale === 1) {
                camScale = maxDim / (2 * 48 * PIXI_SCALE);
            }
        } catch { /* ignore */ }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AIMBOT — find nearest enemy and calculate angle
    // ═══════════════════════════════════════════════════════════════════════

    function findAimTarget(): boolean {
        if (!CFG.aimbot.enabled) { hasAimTarget = false; return false; }

        let bestDist = CFG.aimbot.maxRange ** 2;
        let bestX = 0, bestY = 0;
        let found = false;

        for (const [id, p] of players) {
            if (id === myId) continue;
            if (p.dead || p.downed) continue;
            // Skip teammates
            if (myTeamId >= 0 && p.teamId === myTeamId) continue;

            const dx = p.x - myX;
            const dy = p.y - myY;
            const d2 = dx * dx + dy * dy;

            // FOV check
            if (CFG.aimbot.fov < 360) {
                const angle = Math.atan2(dy, dx);
                const diff  = Math.abs(((angle - aimAngle + Math.PI * 3) % TAU) - Math.PI);
                if (diff > (CFG.aimbot.fov / 2) * (Math.PI / 180)) continue;
            }

            if (d2 < bestDist) {
                bestDist = d2;
                bestX = p.x;
                bestY = p.y;
                found = true;
            }
        }

        if (found) {
            aimTargetX = bestX;
            aimTargetY = bestY;
            hasAimTarget = true;

            const targetAngle = Math.atan2(bestY - myY, bestX - myX);
            // Smooth interpolation
            if (CFG.aimbot.smooth < 1) {
                let diff = targetAngle - aimAngle;
                while (diff >  Math.PI) diff -= TAU;
                while (diff < -Math.PI) diff += TAU;
                aimAngle += diff * CFG.aimbot.smooth;
            } else {
                aimAngle = targetAngle;
            }
        } else {
            hasAimTarget = false;
        }

        return found;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  WEBSOCKET HOOKING — intercept the game's WebSocket
    // ═══════════════════════════════════════════════════════════════════════

    // Save originals
    const _origSend = WebSocket.prototype.send;

    /**
     * Hook WebSocket.prototype.send to:
     *  1) Capture the game's WebSocket reference
     *  2) Modify outgoing input packets (inject aimbot rotation)
     */
    WebSocket.prototype.send = function (this: WebSocket, data: any) {
        // Detect game websocket (URL contains /play)
        if (!gameWs && this.url && this.url.includes("/play")) {
            gameWs = this;
            console.log("%c[CHEAT] Game WebSocket captured!", "color: lime; font-weight: bold");

            // Hook incoming messages for update packet parsing
            this.addEventListener("message", (evt: MessageEvent) => {
                if (evt.data instanceof ArrayBuffer) {
                    try { parseIncomingPacket(evt.data); } catch { /* ignore parse errors */ }
                }
            });
        }

        // Modify outgoing input packets for aimbot
        if (this === gameWs && data instanceof ArrayBuffer && data.byteLength >= 4) {
            try {
                data = modifyInputPacket(data);
            } catch { /* ignore modification errors */ }
        }

        return _origSend.call(this, data);
    };

    // Also hook the WebSocket constructor for new connections
    const _OrigWebSocket = window.WebSocket;
    (window as any).WebSocket = function (url: string | URL, protocols?: string | string[]) {
        const ws = new _OrigWebSocket(url, protocols);

        if (String(url).includes("/play")) {
            gameWs = ws;
            console.log("%c[CHEAT] Game WebSocket intercepted (new connection)!", "color: lime; font-weight: bold");

            ws.addEventListener("message", (evt: MessageEvent) => {
                if (evt.data instanceof ArrayBuffer) {
                    try { parseIncomingPacket(evt.data); } catch { /* ignore */ }
                }
            });
        }

        return ws;
    } as any;
    Object.assign((window as any).WebSocket, _OrigWebSocket);
    (window as any).WebSocket.prototype = _OrigWebSocket.prototype;

    // ═══════════════════════════════════════════════════════════════════════
    //  INPUT PACKET MODIFICATION (aimbot angle injection)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Input packet binary layout (desktop, non-mobile):
     *   Byte 0:     pingSeq (uint8). If bit 7 set, packet is just the seq.
     *   Byte 1:     boolean group (uint8):
     *                 bit 0: movement.up
     *                 bit 1: movement.down
     *                 bit 2: movement.left
     *                 bit 3: movement.right
     *                 bit 4: isMobile
     *                 bit 5: mobile.moving (ignored if not mobile)
     *                 bit 6: turning
     *                 bit 7: attacking
     *   If turning (bit 6 of byte 1):
     *     Bytes 2-3: rotation (uint16 LE, writeRotation2 encoding)
     *     Bytes 4-5: distanceToMouse (uint16 LE, float 0-256 encoded in 2 bytes)
     *   Then: actions array...
     */
    function modifyInputPacket(buf: ArrayBuffer): ArrayBuffer {
        if (!CFG.aimbot.enabled || !hasAimTarget) return buf;
        if (buf.byteLength < 6) return buf;

        const view = new DataView(buf);
        const pingSeq = view.getUint8(0);
        if ((pingSeq & 128) !== 0) return buf;  // GameOver seq, don't touch

        const flags = view.getUint8(1);
        const isMobile = (flags & 0x10) !== 0;
        const isTurning = (flags & 0x40) !== 0;

        if (!isTurning) return buf;  // Not turning, can't inject rotation

        // Rotation is at offset 2 (if not mobile) or 4 (if mobile)
        const rotOffset = isMobile ? 4 : 2;
        if (buf.byteLength < rotOffset + 4) return buf;

        // Clone the buffer so we don't modify the original
        const cloned = buf.slice(0);
        const clonedView = new DataView(cloned);

        // Write aimbot rotation
        const encoded = writeRotation2(aimAngle);
        clonedView.setUint16(rotOffset, encoded, true);

        // Also write distance to mouse (distance to target in game units, clamped to 256)
        const dist = Math.sqrt((aimTargetX - myX) ** 2 + (aimTargetY - myY) ** 2);
        const clampedDist = Math.min(dist, MAX_MOUSE_DIST);
        const encodedDist = Math.round((clampedDist / MAX_MOUSE_DIST) * 65535) & 0xFFFF;
        clonedView.setUint16(rotOffset + 2, encodedDist, true);

        return cloned;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  UPDATE PACKET PARSING (extract player positions)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Attempt to parse incoming update packets to extract player positions.
     *
     * The full update packet is complex, but we use a heuristic approach:
     * we scan for position-like patterns (pairs of uint16 that decode to
     * valid game coordinates) near object ID boundaries.
     *
     * For a more reliable approach, we also track the pixi container tree.
     */
    function parseIncomingPacket(_buf: ArrayBuffer) {
        // The update packet format is extremely complex with many conditional fields.
        // Instead of fully parsing it (which would require reimplementing the entire
        // deserialization layer), we use the pixi display tree for position data.
        // This function is a placeholder for future protocol parsing if needed.
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PIXI DISPLAY TREE SCANNING (reliable position extraction)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Scan the Pixi.js display tree to find player containers and extract
     * their screen positions. This is more reliable than packet parsing
     * since the game has already done the deserialization for us.
     */
    function scanPixiTree() {
        try {
            // Find the pixi stage — it's the parent of all game containers
            const canvas = document.querySelector("canvas");
            if (!canvas) return;

            // Try to access the stage through pixi's internal references
            // Method 1: Pixi DevTools extension sets __PIXI_STAGE__
            const stage = (globalThis as any).__PIXI_STAGE__
                       ?? (globalThis as any).__PIXI_APP__?.stage;
            if (!stage) return;

            // The stage has children: [gameContainer, uiContainer]
            // gameContainer has CameraManager.container as a child
            // CameraManager.container has all game object containers

            const gameContainer = stage.children?.[0];
            if (!gameContainer) return;

            const cameraContainer = gameContainer.children?.[0];
            if (!cameraContainer) return;

            // Read camera transform
            if (cameraContainer.scale?.x) {
                camScale = cameraContainer.scale.x;
            }

            // Scan camera container children for player-like objects
            // Player containers have specific child structure (body, fists, weapon, etc.)
            scanContainer(cameraContainer);
        } catch { /* pixi access failed, fall back to other methods */ }
    }

    function scanContainer(container: any) {
        if (!container?.children) return;

        for (const child of container.children) {
            // Player containers in pixi space have position in pixi coords
            // We can identify them by their structure
            if (child.position && typeof child.position.x === "number") {
                const worldX = child.position.x / PIXI_SCALE;
                const worldY = child.position.y / PIXI_SCALE;

                // Valid game coordinates?
                if (worldX > 0 && worldX < MAX_POS && worldY > 0 && worldY < MAX_POS) {
                    // Check if this looks like a player container
                    // Players typically have 5+ children (body, fists, weapon, emote, etc.)
                    if (child.children && child.children.length >= 4) {
                        // This might be a player — store/update position
                        // Use the container's uid or a hash as the key
                        const id = child.uid ?? child._uid ?? Math.floor(worldX * 1000 + worldY);

                        if (!players.has(id)) {
                            players.set(id, {
                                x: worldX, y: worldY, rotation: child.rotation ?? 0,
                                dead: false, teamId: -1, name: "", health: 1, downed: false,
                            });
                        } else {
                            const p = players.get(id)!;
                            p.x = worldX;
                            p.y = worldY;
                            p.rotation = child.rotation ?? 0;
                        }
                    }
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ALTERNATIVE: GameConsole-based game state access
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Try to use `window.GameConsole` to indirectly access game state.
     * GameConsole is the ONLY game object exposed globally.
     * We use its commands to gather info and its CVar system for settings.
     */
    function tryGameConsoleAccess() {
        const gc = (window as any).GameConsole;
        if (!gc) return;

        // Read player position from the debug CVar if available
        try {
            // The game sets pf_show_pos which displays position
            // We can't read it directly, but we can find the Game reference
            // through module traversal or closure inspection
        } catch { /* ignore */ }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ALTERNATIVE: Access Game via Vite module system (dev mode only)
    // ═══════════════════════════════════════════════════════════════════════

    let gameRef: any = null;
    let inputRef: any = null;

    /**
     * In Vite dev mode, we can dynamically import the game modules.
     * ES modules are deduplicated by URL, so we get the SAME singleton.
     */
    async function tryViteImport() {
        try {
            // This works in Vite dev mode served pages
            const gameMod  = await import("/src/scripts/game.ts" as any);
            const inputMod = await import("/src/scripts/managers/inputManager.ts" as any);

            if (gameMod?.Game) {
                gameRef = gameMod.Game;
                console.log("%c[CHEAT] Game reference acquired via Vite import!", "color: lime; font-weight: bold");
            }
            if (inputMod?.InputManager) {
                inputRef = inputMod.InputManager;
                console.log("%c[CHEAT] InputManager reference acquired!", "color: lime; font-weight: bold");
            }
        } catch {
            // Not in Vite dev mode — expected in production
        }
    }

    // Try Vite import on startup
    tryViteImport();

    // ═══════════════════════════════════════════════════════════════════════
    //  UNIFIED STATE UPDATE (merge all data sources)
    // ═══════════════════════════════════════════════════════════════════════

    function updateState() {
        // === Method 1: Direct Game reference (best, available after Vite import) ===
        if (gameRef) {
            try {
                const me = gameRef.activePlayer;
                if (me) {
                    myId = gameRef.activePlayerID;
                    myX  = me.position.x;
                    myY  = me.position.y;
                    myTeamId = me.teamID ?? -1;
                }

                // Read camera scale from CameraManager
                try {
                    const cam = gameRef.pixi?.stage?.children?.[0]?.children?.[0];
                    if (cam?.scale?.x) camScale = cam.scale.x;
                } catch { /* ignore */ }

                // Get all players from the object pool
                const playerSet = gameRef.objects?.getCategory?.(CAT_PLAYER);
                if (playerSet) {
                    const seenIds = new Set<number>();
                    for (const p of playerSet) {
                        seenIds.add(p.id);
                        const nameInfo = gameRef.playerNames?.get?.(p.id);
                        const existing = players.get(p.id);
                        if (existing) {
                            existing.x = p.position.x;
                            existing.y = p.position.y;
                            existing.rotation = p.rotation;
                            existing.dead = p.dead ?? false;
                            existing.downed = p.downed ?? false;
                            existing.teamId = p.teamID ?? -1;
                            if (nameInfo?.name) existing.name = nameInfo.name;
                        } else {
                            players.set(p.id, {
                                x: p.position.x, y: p.position.y,
                                rotation: p.rotation, dead: p.dead ?? false,
                                teamId: p.teamID ?? -1,
                                name: nameInfo?.name ?? "",
                                health: 1, downed: p.downed ?? false,
                            });
                        }
                    }
                    // Remove players no longer in the pool
                    for (const id of players.keys()) {
                        if (!seenIds.has(id)) players.delete(id);
                    }
                }

                // Get loot
                if (CFG.esp.loot) {
                    const lootSet = gameRef.objects?.getCategory?.(CAT_LOOT);
                    if (lootSet) {
                        lootItems.clear();
                        for (const l of lootSet) {
                            const dist = Math.hypot(l.position.x - myX, l.position.y - myY);
                            if (dist < CFG.esp.lootRange) {
                                lootItems.set(l.id, {
                                    x: l.position.x, y: l.position.y,
                                    name: l.definition?.idString ?? "???",
                                });
                            }
                        }
                    }
                }

                return; // Game ref is the best source, don't need fallbacks
            } catch { /* Game ref failed, fall through */ }
        }

        // === Method 2: Pixi display tree (fallback) ===
        scanPixiTree();

        // === Method 3: GameConsole heuristics ===
        tryGameConsoleAccess();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AIMBOT — Direct InputManager modification (when available)
    // ═══════════════════════════════════════════════════════════════════════

    function applyDirectAimbot() {
        if (!inputRef || !CFG.aimbot.enabled || !hasAimTarget) return;

        try {
            // Directly set InputManager's rotation
            inputRef.rotation = aimAngle;
            inputRef.turning  = true;

            // Set distance to mouse
            const dist = Math.sqrt((aimTargetX - myX) ** 2 + (aimTargetY - myY) ** 2);
            inputRef.distanceToMouse = Math.min(dist, MAX_MOUSE_DIST);
        } catch { /* InputManager access failed */ }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ESP RENDERING
    // ═══════════════════════════════════════════════════════════════════════

    function renderESP() {
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        if (!CFG.esp.enabled && !CFG.aimbot.showLine) return;

        const screenCenterX = overlay.width  / 2;
        const screenCenterY = overlay.height / 2;

        // ── Draw players ──
        if (CFG.esp.enabled) {
            for (const [id, p] of players) {
                if (id === myId) continue;

                const { sx, sy } = worldToScreen(p.x, p.y);

                // Skip offscreen
                if (sx < -100 || sx > overlay.width + 100 || sy < -100 || sy > overlay.height + 100) continue;

                // Color: dead=gray, team=green, enemy=red
                let color = CFG.esp.enemyColor;
                if (p.dead || p.downed) color = CFG.esp.deadColor;
                else if (myTeamId >= 0 && p.teamId === myTeamId) color = CFG.esp.teamColor;

                const boxSize = 30 * camScale;

                // Box
                if (CFG.esp.boxes) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth   = 2;
                    ctx.strokeRect(sx - boxSize / 2, sy - boxSize, boxSize, boxSize * 1.5);

                    // Corner accent marks
                    const corner = 6;
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    // Top-left
                    ctx.moveTo(sx - boxSize / 2, sy - boxSize + corner);
                    ctx.lineTo(sx - boxSize / 2, sy - boxSize);
                    ctx.lineTo(sx - boxSize / 2 + corner, sy - boxSize);
                    // Top-right
                    ctx.moveTo(sx + boxSize / 2 - corner, sy - boxSize);
                    ctx.lineTo(sx + boxSize / 2, sy - boxSize);
                    ctx.lineTo(sx + boxSize / 2, sy - boxSize + corner);
                    // Bottom-left
                    ctx.moveTo(sx - boxSize / 2, sy + boxSize / 2 - corner);
                    ctx.lineTo(sx - boxSize / 2, sy + boxSize / 2);
                    ctx.lineTo(sx - boxSize / 2 + corner, sy + boxSize / 2);
                    // Bottom-right
                    ctx.moveTo(sx + boxSize / 2 - corner, sy + boxSize / 2);
                    ctx.lineTo(sx + boxSize / 2, sy + boxSize / 2);
                    ctx.lineTo(sx + boxSize / 2, sy + boxSize / 2 - corner);
                    ctx.stroke();
                }

                // Tracer line
                if (CFG.esp.tracers) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth   = 1;
                    ctx.globalAlpha = 0.6;
                    ctx.beginPath();
                    ctx.moveTo(screenCenterX, overlay.height);
                    ctx.lineTo(sx, sy);
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                }

                // Health bar
                if (CFG.esp.health && p.health > 0 && p.health < 1) {
                    const barW = boxSize;
                    const barH = 4;
                    const barX = sx - barW / 2;
                    const barY = sy - boxSize - 8;
                    ctx.fillStyle = "#000";
                    ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
                    ctx.fillStyle = p.health > 0.5 ? "#0f0" : p.health > 0.25 ? "#ff0" : "#f00";
                    ctx.fillRect(barX, barY, barW * p.health, barH);
                }

                // Name
                if (CFG.esp.names && p.name) {
                    ctx.font = "bold 11px sans-serif";
                    ctx.textAlign = "center";
                    ctx.fillStyle = color;
                    ctx.strokeStyle = "#000";
                    ctx.lineWidth = 2;
                    ctx.strokeText(p.name, sx, sy - boxSize - 12);
                    ctx.fillText(p.name, sx, sy - boxSize - 12);
                }

                // Distance
                const dist = Math.round(Math.hypot(p.x - myX, p.y - myY));
                ctx.font = "10px sans-serif";
                ctx.textAlign = "center";
                ctx.fillStyle = "#fff";
                ctx.fillText(`${dist}m`, sx, sy + boxSize / 2 + 14);
            }
        }

        // ── Draw loot ──
        if (CFG.esp.enabled && CFG.esp.loot) {
            for (const [, l] of lootItems) {
                const { sx, sy } = worldToScreen(l.x, l.y);
                if (sx < -50 || sx > overlay.width + 50 || sy < -50 || sy > overlay.height + 50) continue;

                ctx.font = "9px sans-serif";
                ctx.textAlign = "center";
                ctx.fillStyle = CFG.esp.lootColor;
                ctx.strokeStyle = "#000";
                ctx.lineWidth = 1.5;
                const displayName = l.name.replace(/_/g, " ");
                ctx.strokeText(displayName, sx, sy - 8);
                ctx.fillText(displayName, sx, sy - 8);

                // Small diamond marker
                ctx.fillStyle = CFG.esp.lootColor;
                ctx.beginPath();
                ctx.moveTo(sx, sy - 4);
                ctx.lineTo(sx + 3, sy);
                ctx.lineTo(sx, sy + 4);
                ctx.lineTo(sx - 3, sy);
                ctx.closePath();
                ctx.fill();
            }
        }

        // ── Aimbot line ──
        if (CFG.aimbot.showLine && hasAimTarget) {
            const { sx, sy } = worldToScreen(aimTargetX, aimTargetY);
            ctx.strokeStyle = CFG.aimbot.lineColor;
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(screenCenterX, screenCenterY);
            ctx.lineTo(sx, sy);
            ctx.stroke();
            ctx.setLineDash([]);

            // Crosshair on target
            const size = 8;
            ctx.strokeStyle = CFG.aimbot.lineColor;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(sx - size, sy); ctx.lineTo(sx + size, sy);
            ctx.moveTo(sx, sy - size); ctx.lineTo(sx, sy + size);
            ctx.stroke();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  MAIN LOOP
    // ═══════════════════════════════════════════════════════════════════════

    function tick() {
        updateState();
        findAimTarget();

        // If we have direct InputManager access, use it (more reliable than packet mod)
        if (inputRef) applyDirectAimbot();

        renderESP();
        updateHud();

        requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);

    // ═══════════════════════════════════════════════════════════════════════
    //  KEYBINDS
    // ═══════════════════════════════════════════════════════════════════════

    document.addEventListener("keydown", (e: KeyboardEvent) => {
        switch (e.key) {
            case "F1":
                e.preventDefault();
                CFG.esp.enabled = !CFG.esp.enabled;
                console.log(`[CHEAT] ESP: ${CFG.esp.enabled ? "ON" : "OFF"}`);
                break;
            case "F2":
                e.preventDefault();
                CFG.aimbot.enabled = !CFG.aimbot.enabled;
                console.log(`[CHEAT] Aimbot: ${CFG.aimbot.enabled ? "ON" : "OFF"}`);
                break;
            case "F3":
                e.preventDefault();
                CFG.aimbot.showLine = !CFG.aimbot.showLine;
                break;
            case "F4":
                e.preventDefault();
                if (CFG.esp.boxes && CFG.esp.tracers) {
                    CFG.esp.tracers = false;
                } else if (CFG.esp.boxes) {
                    CFG.esp.boxes = false;
                    CFG.esp.tracers = true;
                } else {
                    CFG.esp.boxes = true;
                    CFG.esp.tracers = true;
                }
                break;
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  CLEANUP FUNCTION
    // ═══════════════════════════════════════════════════════════════════════

    (window as any).__cheatCleanup = () => {
        WebSocket.prototype.send = _origSend;
        (window as any).WebSocket = _OrigWebSocket;
        overlay.remove();
        hud.remove();
        console.log("%c[CHEAT] Cleaned up!", "color: red; font-weight: bold");
    };

    // ═══════════════════════════════════════════════════════════════════════
    //  STARTUP
    // ═══════════════════════════════════════════════════════════════════════

    console.log("%c╔══════════════════════════════════════╗", "color: #ff2040; font-size: 14px");
    console.log("%c║   SUROI AIMBOT + ESP LOADED          ║", "color: #ff2040; font-size: 14px; font-weight: bold");
    console.log("%c╠══════════════════════════════════════╣", "color: #ff2040; font-size: 14px");
    console.log("%c║  F1 = Toggle ESP                     ║", "color: #0f0; font-size: 12px");
    console.log("%c║  F2 = Toggle Aimbot                  ║", "color: #0f0; font-size: 12px");
    console.log("%c║  F3 = Toggle Aim Lines               ║", "color: #0f0; font-size: 12px");
    console.log("%c║  F4 = Cycle ESP Mode                 ║", "color: #0f0; font-size: 12px");
    console.log("%c║  __cheatCleanup() = Remove cheat     ║", "color: #ff0; font-size: 12px");
    console.log("%c╚══════════════════════════════════════╝", "color: #ff2040; font-size: 14px");

})();
