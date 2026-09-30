/**
 * Suroi ULTIMATE Cheat v3 — ALL FIXES
 *
 * FIXES IN v3:
 *   - Aimbot fires CONTINUOUSLY via InputManager monkey-patch
 *   - Auto-fire works by HOLDING mouse (no clicking each time)
 *   - Health bars REMOVED for enemies (data not available, was fake 100%)
 *   - Melee lock ACTUALLY aims at target (rotation injected before packet)
 *   - Kill leader shown as GOLD dot on minimap and fullmap
 *   - Tango crate locations shown as PURPLE markers on minimap and fullmap
 *   - Gold rock (Mosin) locations shown as MAGENTA markers
 *   - Enemy dots appear on FULL MAP (big map) too
 *   - UI panel no longer steals focus from game canvas
 *
 * CONTROLS:  \  = Toggle cheat UI panel
 */
(() => {
    "use strict";

    const CFG = {
        esp: {
            enabled: true, boxes: true, tracers: true, names: true,
            loot: true, lootRange: 150,
            enemyColor: "#ff2040", teamColor: "#00ff80", lootColor: "#ffaa00",
        },
        aimbot: {
            enabled: true, showLine: true, fov: 360, smooth: 1.0,
            maxRange: 500, lineColor: "#ff00ff", autoFire: true,
        },
        autoFire: { enabled: true },
        xray: { enabled: false },
        zoom: { enabled: false, level: 1.0, min: 0.3, max: 3.0, step: 0.1 },
        meleeLock: { enabled: false, chaseRange: 200, punchRange: 4.0 },
        map: {
            enemyDots: true, killLeaderDot: true, tangoCrates: true, goldRocks: true,
            dotSize: 4, markerSize: 12,
            enemyColor: "#ff2040", killLeaderColor: "#ffd700",
            tangoColor: "#9b59b6", goldRockColor: "#e91e8c",
        },
        ui: { visible: true },
    };

    const TAU = Math.PI * 2;
    const PIXI_SCALE = 20;
    const CAT_PLAYER = 0;
    const CAT_OBSTACLE = 1;
    const CAT_LOOT = 3;
    const CAT_BUILDING = 4;
    const IA_EQUIP_ITEM = 0;

    let gameRef = null;
    let inputRef = null;
    let cameraRef = null;
    let mapRef = null;
    let uiManagerRef = null;

    let hasAimTarget = false;
    let aimTargetX = 0, aimTargetY = 0;
    let aimAngle = 0, aimDist = 0, aimTargetId = -1;
    let mouseIsDown = false;
    let patchApplied = false;
    let xrayHiddenElements = [];
    let zoomBaseValue = null;
    let tangoCratePositions = [];
    let goldRockPositions = [];
    let lastObstacleScan = 0;
    let attackCycleTick = 0;
    let cachedAttackControlActive = false;
    let cachedAttackPulseValue = false;
    let gameWs = null;
    let isMeleeChasing = false;
    const meleeActiveKeys = new Set();
    let healingUntil = 0; // timestamp: don't override attacks until this time (healing protection)

           // ==========================================
    // AGGRESSIVE WIRETAP & SCANNER (Replaces import())
    // ==========================================
    function checkObject(obj, source) {
        if (!obj || typeof obj !== 'object') return;
        
        if (!gameRef && (obj.activePlayerID !== undefined || (obj.pixi && obj.pixi.stage))) {
            gameRef = obj; 
            console.log("%c[CHEAT] Game ref OK (via " + source + ")", "color:lime");
        }
        if (!inputRef && obj.attacking !== undefined && obj.rotation !== undefined && obj.movement) {
            inputRef = obj; 
            console.log("%c[CHEAT] InputManager ref OK (via " + source + ")", "color:lime");
            // PATCH IMMEDIATELY THE MOMENT IT IS FOUND!
            setupDirectPacketSender();
        }
        if (!cameraRef && obj.zoom !== undefined && obj.position && obj.container && obj.container.scale) {
            cameraRef = obj; 
            console.log("%c[CHEAT] CameraManager ref OK (via " + source + ")", "color:lime");
        }
        if (!mapRef && obj._minimapWidth !== undefined) {
            mapRef = obj; 
            console.log("%c[CHEAT] MapManager ref OK (via " + source + ")", "color:lime");
        }
        if (!uiManagerRef && obj.inventory && obj.killLeaderCache) {
            uiManagerRef = obj; 
            console.log("%c[CHEAT] UIManager ref OK (via " + source + ")", "color:lime");
        }
    }

    // Deep search helper to find hidden managers inside the Game object
    function deepSearch(root, depth = 0) {
        if (depth > 5 || !root || typeof root !== 'object') return;
        try {
            for (const key in root) {
                if (key === 'parent' || key === 'constructor' || key === 'prototype' || key === 'ownerDocument') continue;
                try {
                    const val = root[key];
                    if (val && typeof val === 'object') {
                        checkObject(val, "deepSearch." + key);
                        // Keep digging until we find inputRef
                        if (!inputRef) deepSearch(val, depth + 1);
                    }
                } catch(e) {}
            }
        } catch(e) {}
    }

    // Install the wiretaps on native browser APIs
    const _origBind = Function.prototype.bind;
    Function.prototype.bind = function(context, ...args) { 
        checkObject(context, "bind"); 
        return _origBind.call(this, context, ...args); 
    };
    
    const _origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function(cb) { 
        if(cb && typeof cb === 'object' && cb.handleEvent) checkObject(cb, "RAF"); 
        return _origRAF.call(this, cb); 
    };

    const _origAddEvent = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, opts) { 
        if(listener && typeof listener === 'object' && listener.handleEvent) checkObject(listener, "Event"); 
        return _origAddEvent.call(this, type, listener, opts); 
    };

    // ==========================================
    // CONTINUOUS SCANNER (Replaces the failing while-loop)
    // ==========================================
    let scanInterval = null;

    function startContinuousScan() {
        if (scanInterval) return; // Already running
        
        console.log("%c[CHEAT] 🚀 Starting continuous memory scan...", "color: yellow");
        
        scanInterval = setInterval(() => {
            // 1. If we already have everything, stop scanning to save performance
            if (gameRef && inputRef && cameraRef && mapRef && uiManagerRef) {
                console.log("%c[CHEAT] ✅ All references acquired! Stopping scan.", "color: lime; font-weight: bold");
                clearInterval(scanInterval);
                return;
            }

            // 2. Scan window object for singletons
            for (const key in window) {
                try {
                    const obj = window[key];
                    if (obj && typeof obj === 'object') {
                        checkObject(obj, "window." + key);
                    }
                } catch(e) {}
            }

            // 3. If we have Game but no Input, deep search the Game object
            if (gameRef && !inputRef) {
                deepSearch(gameRef);
            }
            
            // 4. If we have PIXI stage but no Input, deep search the stage
            if (gameRef && gameRef.pixi && gameRef.pixi.stage && !inputRef) {
                deepSearch(gameRef.pixi.stage);
            }

        }, 1000); // Scan every 1 second
    }

    // ==========================================
    // REPLACED acquireRefs FUNCTION
    // ==========================================
    async function acquireRefs() {
        console.log("%c[CHEAT] Initializing Wiretap & Scanner (no imports needed)...", "color: yellow");
        startContinuousScan();
    }

    function tryAcquireRefs() {
        acquireRefs();
    }
    
    // Start the process safely after page load
    window.addEventListener('load', () => {
        setTimeout(tryAcquireRefs, 1000);
    });

    // === MONKEY-PATCH InputManager.update() ===
    // THE KEY FIX: inject aimbot/autofire/melee overrides RIGHT BEFORE
    // the game builds the input packet. Ensures:
    //   - attacking=true survives the game pointerup reset
    //   - rotation is aimAngle, not mouse cursor
    //   - turning=true so rotation data IS in the packet
    //   - _inputPacketTimer forced so packet sends every frame
    // Helper: check if current weapon is melee
    // player.activeItem IS the WeaponDefinition directly (not a wrapper)
    // DefinitionType.Melee = 13 (const enum, compiled to number)
    function isHoldingMelee() {
        try {
            var player = getMyPlayer();
            if (!player) return false;
            var item = player.activeItem;
            // DefinitionType.Melee = 13
            if (item && item.defType === 13) return true;
            // Fallback: check idString for known melee weapons
            if (item && typeof item.idString === "string") {
                var id = item.idString;
                if (id === "fists" || id === "baseball_bat" || id === "kbar"
                    || id === "sickle" || id === "seax" || id === "maul"
                    || id === "heap_sword" || id === "ice_pick" || id === "hatchet"
                    || id === "gas_can") return true;
            }
            // Fallback: check UIManager inventory slot (slot 2 = melee)
            if (uiManagerRef && uiManagerRef.inventory && uiManagerRef.inventory.activeWeaponIndex === 2) return true;
        } catch (e) {}
        return false;
    }

    // Helper: check if current weapon is automatic
    // FireMode is a const enum: Single=0, Burst=1, Auto=2
    function isAutoWeapon() {
        try {
            var player = getMyPlayer();
            if (!player) return false;
            var item = player.activeItem;
            if (item && (item.fireMode === 2 || item.fireMode === 1)) return true; // 2=Auto, 1=Burst
        } catch (e) {}
        return false;
    }

    // Helper: check if current weapon is a gun (not melee, not healing, not throwable)
    // DefinitionType.Gun = 9
    function isHoldingGun() {
        try {
            var player = getMyPlayer();
            if (!player) return false;
            var item = player.activeItem;
            if (!item) return false;
            // Direct defType check: Gun = 9
            if (item.defType === 9) return true;
            // Explicitly NOT a gun:
            // Melee = 13, HealingItem = 10, Throwable = 19
            if (item.defType === 13 || item.defType === 10 || item.defType === 19) return false;
            // Fallback: check idString for known melee/healing/throwable
            if (typeof item.idString === "string") {
                var id = item.idString;
                if (id === "fists" || id === "baseball_bat" || id === "kbar"
                    || id === "sickle" || id === "seax" || id === "maul"
                    || id === "heap_sword" || id === "ice_pick" || id === "hatchet"
                    || id === "gas_can") return false;
                if (id === "gauze" || id === "medikit" || id === "cola" || id === "tablets"
                    || id === "bandage" || id === "med_kit" || id === "soda" || id === "pills") return false;
                if (id === "frag_grenade" || id === "smoke_grenade" || id === "mirv_grenade"
                    || id === "confetti_grenade" || id === "c4") return false;
            }
            // If it has fireDelay (guns have this, melee uses cooldown instead)
            if (item.fireDelay !== undefined) return true;
        } catch (e) {}
        return false;
    }

    // Helper: check if player is currently healing or recently started healing
    // Uses TWO methods:
    //   1. Server-confirmed: player.action.type !== 0 (PlayerActions.None=0, Reload=1, UseItem=2, Revive=3)
    //   2. Timer-based: covers the gap between sending UseItem action and server confirming it
    // This prevents the cheat from canceling heals by forcing attacking=true
    function isHealingActive() {
        try {
            var player = getMyPlayer();
            if (player && player.action && player.action.type !== undefined && player.action.type !== 0) {
                // Server confirmed an action is in progress — extend protection
                healingUntil = Date.now() + 500;
                return true;
            }
        } catch (e) {}
        // Timer protection: covers gap between sending healing action and server confirmation
        if (Date.now() < healingUntil) return true;
        return false;
    }

    // Scan InputManager actions queue for healing actions and set the healingUntil timer
    // InputActions.UseItem = 12, DefinitionType.HealingItem = 10
    function checkActionsForHealing(actions) {
        if (!actions) return;
        for (var i = 0; i < actions.length; i++) {
            var act = actions[i];
            if (!act) continue;
            // UseItem action with a HealingItem
            if (act.type === 12 && act.item && act.item.defType === 10) {
                healingUntil = Date.now() + 2000; // 2s buffer until server confirms
                return;
            }
            // Cancel action (InputActions.Cancel = 11) — clear healing timer
            if (act.type === 11) {
                healingUntil = 0;
                return;
            }
        }
    }

    // Build repeated false->true attack edges for single-fire guns and melee.
    // Auto and burst can stay continuously true.
    function getAttackPulse(baseShouldAttack) {
        if (!baseShouldAttack) {
            attackCycleTick = 0;
            cachedAttackControlActive = false;
            cachedAttackPulseValue = false;
            return false;
        }

        cachedAttackControlActive = true;

        var player = getMyPlayer();
        var item = player ? player.activeItem : null;
        var autoLike = !!(item && (item.fireMode === 2 || item.fireMode === 1)); // Auto or Burst

        if (autoLike) {
            attackCycleTick = 0;
            cachedAttackPulseValue = true;
            return true;
        }

        attackCycleTick++;

        var fireDelayMs = 90;
        if (item) {
            if (typeof item.fireDelay === "number") fireDelayMs = item.fireDelay;
            else if (typeof item.cooldown === "number") fireDelayMs = item.cooldown;
        }

        var cycleTicks = Math.max(3, Math.ceil(fireDelayMs / 16));
        cachedAttackPulseValue = (attackCycleTick % cycleTicks) !== 0;
        return cachedAttackPulseValue;
    }

    // === CHEAT INPUT INJECTION ===
    // DUAL-LAYER approach for maximum reliability:
    //   Layer 1: Patch InputManager PROTOTYPE .update() — injects values BEFORE packet is built
    //   Layer 2: Patch Game PROTOTYPE .sendPacket() — modifies packet AFTER it's built (backup)
    // Using prototype patches ensures the game's own references always hit our wrappers.
    function setupDirectPacketSender() {
        if (patchApplied) return;
        if (!gameRef || !inputRef) { console.warn("[CHEAT] Refs not ready, can't setup"); return; }
        patchApplied = true;

        // === LAYER 1: Patch InputManager.prototype.update ===
        // The game's render loop calls InputManager.update() every frame.
        // We inject attacking/rotation/turning BEFORE the original code reads them.
        var inputProto = Object.getPrototypeOf(inputRef);
        var origUpdate = inputProto.update;
        console.log("[CHEAT] InputManager.prototype.update exists:", typeof origUpdate === "function");

        inputProto.update = function cheatUpdate() {

            var shouldAttack = false;
            var wantsAttack = false;
            var shouldOverrideAim = false;
            var shouldChase = false;
            var targetAngle = 0;
            var targetDist = 128;
            var chaseDx = 0, chaseDy = 0;

            // FIRST: scan the actions queue for healing actions and set timer
            checkActionsForHealing(this.actions);

            // SKIP ALL COMBAT OVERRIDES if player is healing
            var healing = isHealingActive();

            if (!healing && mouseIsDown) {
                // AIMBOT — only when holding a GUN
                if (CFG.aimbot.enabled && hasAimTarget && isHoldingGun()) {
                    shouldOverrideAim = true;
                    targetAngle = aimAngle;
                    targetDist = Math.min(aimDist, 128);
                    if (CFG.aimbot.autoFire) {
                        wantsAttack = true;
                    }
                }

                // FULL-AUTO ALL: always pulse attack if enabled and mouse held (guns or melee)
                if (CFG.autoFire.enabled && (isHoldingGun() || isHoldingMelee())) {
                    wantsAttack = true;
                }

                // Melee auto-aim assist when full-auto is active and target exists
                if (CFG.autoFire.enabled && isHoldingMelee() && hasAimTarget) {
                    shouldOverrideAim = true;
                    targetAngle = aimAngle;
                    targetDist = Math.min(aimDist, 128);
                }

                // MELEE LOCK — only when holding MELEE weapon AND enemy is within chase range
                if (CFG.meleeLock.enabled && hasAimTarget && isHoldingMelee() && aimDist < CFG.meleeLock.chaseRange) {
                    shouldOverrideAim = true;
                    targetAngle = aimAngle;
                    targetDist = Math.min(aimDist, 128);
                    wantsAttack = true;

                    // CHASE: compute movement toward target
                    // (Direct movement injection — simulateKey doesn't work because game rejects untrusted events)
                    if (aimDist > CFG.meleeLock.punchRange * 0.7) {
                        shouldChase = true;
                        var me = getMyPos();
                        chaseDx = aimTargetX - me.x;
                        chaseDy = aimTargetY - me.y;
                    }
                }
            }

            shouldAttack = getAttackPulse(wantsAttack);

            // INJECT values right before origUpdate reads them
            if (shouldAttack) {
                this.attacking = true;
                this.resetAttacking = false;
            }
            if (shouldOverrideAim) {
                this.turning = true;
                this.rotation = targetAngle;
                this.distanceToMouse = targetDist;
            }
            if (shouldChase) {
                // Override movement WASD directly on the InputManager object
                // This is the ONLY way that works — the game ignores synthetic KeyboardEvents (isTrusted check)
                this.movement.up = chaseDy < -0.3;
                this.movement.down = chaseDy > 0.3;
                this.movement.left = chaseDx < -0.3;
                this.movement.right = chaseDx > 0.3;
            }
            if (shouldAttack || shouldOverrideAim) {
                this._inputPacketTimer = 200; // force packet to actually send
            }

            // Call original update — it reads this.attacking, this.rotation, etc.
            return origUpdate.call(this);
        };
        console.log("%c[CHEAT] Layer 1: InputManager.prototype.update patched!", "color:lime;font-weight:bold");

        // === LAYER 2 (BACKUP): Patch Game.prototype.sendPacket ===
        // In case Layer 1 values get lost, we also modify the packet object in flight.
        var gameProto = Object.getPrototypeOf(gameRef);
        var origSendPacket = gameProto.sendPacket;
        console.log("[CHEAT] Game.prototype.sendPacket exists:", typeof origSendPacket === "function");

        gameProto.sendPacket = function cheatSendPacket(packet) {
            // Input packets have type === 2 (PacketType.Input)
            if (packet && packet.type === 2) {
                var shouldAttack = false;
                var shouldOverrideAim = false;
                var targetAngle = 0;
                var targetDist = 128;

                // Check actions in the packet for healing
                if (packet.actions) checkActionsForHealing(packet.actions);

                // SKIP ALL OVERRIDES if healing
                var healing = isHealingActive();

                if (!healing && mouseIsDown) {
                    // AIMBOT — only when holding a GUN
                    if (CFG.aimbot.enabled && hasAimTarget && isHoldingGun()) {
                        shouldOverrideAim = true;
                        targetAngle = aimAngle;
                        targetDist = Math.min(aimDist, 128);
                        if (CFG.aimbot.autoFire) {
                            shouldAttack = true;
                        }
                    }
                    // AUTO-FIRE — guns + melee when mouse is held
                    if (CFG.autoFire.enabled && (isHoldingGun() || isHoldingMelee())) {
                        shouldAttack = true;
                    }
                    // MELEE LOCK — only when holding MELEE AND enemy within chase range
                    if (CFG.meleeLock.enabled && hasAimTarget && isHoldingMelee() && aimDist < CFG.meleeLock.chaseRange) {
                        shouldOverrideAim = true;
                        targetAngle = aimAngle;
                        targetDist = Math.min(aimDist, 128);
                        shouldAttack = true;
                    }
                }

                if (shouldAttack) {
                    // Respect Layer 1 pulse timing when available so single-fire/melee keep retriggering.
                    packet.attacking = cachedAttackControlActive ? cachedAttackPulseValue : getAttackPulse(true);
                }
                if (shouldOverrideAim) {
                    packet.turning = true;
                    packet.rotation = targetAngle;
                    packet.distanceToMouse = targetDist;
                }
            }
            return origSendPacket.call(this, packet);
        };
        console.log("%c[CHEAT] Layer 2: Game.prototype.sendPacket patched!", "color:lime;font-weight:bold");
    }

    // === DIAGNOSTIC FUNCTION ===
    // Call window.__testCheat() in console to verify everything works
    window.__testCheat = function() {
        console.log("=== CHEAT DIAGNOSTIC ===");
        console.log("gameRef:", gameRef ? "OK (" + typeof gameRef + ")" : "NULL");
        console.log("inputRef:", inputRef ? "OK (" + typeof inputRef + ")" : "NULL");
        console.log("patchApplied:", patchApplied);
        console.log("mouseIsDown:", mouseIsDown);
        console.log("hasAimTarget:", hasAimTarget);
        console.log("aimAngle:", aimAngle, "aimDist:", aimDist);
        console.log("isHoldingMelee():", isHoldingMelee());
        console.log("isHoldingGun():", isHoldingGun());
        console.log("isAutoWeapon():", isAutoWeapon());
        console.log("isHealingActive():", isHealingActive());
        console.log("healingUntil:", healingUntil, "now:", Date.now(), "diff:", healingUntil - Date.now());
        try {
            var player = getMyPlayer();
            if (player && player.activeItem) {
                console.log("activeItem.defType:", player.activeItem.defType);
                console.log("activeItem.idString:", player.activeItem.idString);
            }
        } catch(e) { console.log("activeItem read error:", e.message); }
        if (uiManagerRef && uiManagerRef.inventory) {
            console.log("UIManager.inventory.activeWeaponIndex:", uiManagerRef.inventory.activeWeaponIndex);
        }
        if (inputRef) {
            console.log("inputRef.attacking:", inputRef.attacking);
            console.log("inputRef.turning:", inputRef.turning);
            console.log("inputRef.rotation:", inputRef.rotation);
            console.log("inputRef._inputPacketTimer:", inputRef._inputPacketTimer);
            console.log("inputRef.gameStarted check:", gameRef ? gameRef.gameStarted : "no gameRef");
            var proto = Object.getPrototypeOf(inputRef);
            console.log("update patched:", proto.update && proto.update.name === "cheatUpdate");
        }
        if (gameRef) {
            var gp = Object.getPrototypeOf(gameRef);
            console.log("sendPacket patched:", gp.sendPacket && gp.sendPacket.name === "cheatSendPacket");
            console.log("gameStarted:", gameRef.gameStarted);
            console.log("activePlayer:", gameRef.activePlayer ? "present" : "null");
        }
        var enemies = getEnemyPlayers();
        console.log("enemies visible:", enemies.length);
        if (enemies.length > 0) {
            console.log("  closest dist:", Math.round(aimDist) + "m, angle:", (aimAngle * 180 / Math.PI).toFixed(1) + "°");
        }
        console.log("=== END DIAGNOSTIC ===");
        return "Done - check messages above";
    };

    // Debug logging (periodic)
    var lastDebugLog = 0;
    function logDebugState() {
        var now = Date.now();
        if (now - lastDebugLog > 2000) {
            lastDebugLog = now;
            console.log("[CHEAT-DBG] mouseIsDown=" + mouseIsDown
                + " aimbot=" + CFG.aimbot.enabled
                + " melee=" + CFG.meleeLock.enabled
                + " hasTarget=" + hasAimTarget
                + " holdingMelee=" + isHoldingMelee()
                + " holdingGun=" + isHoldingGun()
                + " aimDist=" + Math.round(aimDist)
                + " healing=" + isHealingActive()
                + " patchApplied=" + patchApplied
                + " updatePatched=" + (inputRef ? (Object.getPrototypeOf(inputRef).update.name === "cheatUpdate") : "N/A")
                + " sendPatched=" + (gameRef ? (Object.getPrototypeOf(gameRef).sendPacket.name === "cheatSendPacket") : "N/A"));
        }
    }

    // === HELPERS ===
    function getMyPlayer() { return gameRef ? (gameRef.activePlayer || null) : null; }
    function getMyPos() {
        var p = getMyPlayer();
        return p ? { x: p.position.x, y: p.position.y } : { x: 0, y: 0 };
    }
    function getMyId() { return gameRef ? (gameRef.activePlayerID || -1) : -1; }
    function getMyTeamId() { return gameRef ? (gameRef.teamID || -1) : -1; }

    function getEnemyPlayers() {
        var result = [];
        if (!gameRef) return result;
        var set = gameRef.objects && gameRef.objects.getCategory ? gameRef.objects.getCategory(CAT_PLAYER) : null;
        if (!set) return result;
        var myId = getMyId();
        var myTeam = getMyTeamId();
        for (var p of set) {
            if (p.id === myId) continue;
            if (p.dead || p.downed) continue;
            if (myTeam >= 0 && (p.teamID === undefined ? -1 : p.teamID) === myTeam) continue;
            result.push(p);
        }
        return result;
    }

    function getPlayerName(id) {
        if (!gameRef || !gameRef.playerNames) return null;
        var info = gameRef.playerNames.get(id);
        return info ? (info.name || null) : null;
    }

    function getKillLeaderId() {
        if (!uiManagerRef || !uiManagerRef.killLeaderCache) return -1;
        var id = uiManagerRef.killLeaderCache.id;
        return (id === 65535 || id === undefined) ? -1 : id;
    }

    // === CANVAS OVERLAY ===
    var overlay = document.createElement("canvas");
    overlay.id = "cheat-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:999999;";
    document.body.appendChild(overlay);
    var ctx = overlay.getContext("2d");
    function resizeOverlay() { overlay.width = window.innerWidth; overlay.height = window.innerHeight; }
    resizeOverlay();
    window.addEventListener("resize", resizeOverlay);

    // === COORDINATE CONVERSION ===
    function worldToScreen(wx, wy) {
        if (cameraRef && cameraRef.container) {
            var c = cameraRef.container;
            var scale = c.scale ? (c.scale.x || 1) : 1;
            return { sx: wx * PIXI_SCALE * scale + c.position.x, sy: wy * PIXI_SCALE * scale + c.position.y, scale: scale };
        }
        var cx2 = overlay.width / 2, cy2 = overlay.height / 2;
        var me2 = getMyPos();
        var maxDim = Math.max(overlay.width, overlay.height);
        var sc = maxDim * 0.5 / (48 * PIXI_SCALE);
        return { sx: cx2 + (wx - me2.x) * PIXI_SCALE * sc, sy: cy2 + (wy - me2.y) * PIXI_SCALE * sc, scale: sc };
    }

    // World -> map screen (works for BOTH minimap AND full/big map)
    function worldToMapScreen(wx, wy) {
        if (!mapRef || !mapRef.container) return null;
        try {
            var c = mapRef.container;
            var oc = mapRef._objectsContainer;
            if (!oc) return null;
            return {
                x: (wx + oc.position.x) * c.scale.x + c.position.x,
                y: (wy + oc.position.y) * c.scale.y + c.position.y
            };
        } catch (e) { return null; }
    }

    function getMapClipRect() {
        if (!mapRef) return null;
        try {
            var mx = mapRef.margins ? mapRef.margins.x : 0;
            var my = mapRef.margins ? mapRef.margins.y : 0;
            var mw = mapRef._minimapWidth || 0;
            var mh = mapRef._minimapHeight || 0;
            if (mw < 1 || mh < 1) return null;
            return { x: mx, y: my, w: mw, h: mh };
        } catch (e) { return null; }
    }

    // === AIMBOT TARGET FINDING ===
    function findAimTarget() {
        if (!CFG.aimbot.enabled && !CFG.meleeLock.enabled) {
            hasAimTarget = false; aimTargetId = -1; return;
        }
        var me = getMyPos();
        var bestDist = CFG.aimbot.maxRange * CFG.aimbot.maxRange;
        var bestX = 0, bestY = 0, bestId = -1, found = false;
        var enemies = getEnemyPlayers();
        for (var i = 0; i < enemies.length; i++) {
            var p = enemies[i];
            var dx = p.position.x - me.x;
            var dy = p.position.y - me.y;
            var d2 = dx * dx + dy * dy;
            if (d2 < bestDist) { bestDist = d2; bestX = p.position.x; bestY = p.position.y; bestId = p.id; found = true; }
        }
        if (found) {
            aimTargetX = bestX; aimTargetY = bestY; aimTargetId = bestId;
            hasAimTarget = true; aimDist = Math.sqrt(bestDist);
            var targetAngle = Math.atan2(bestY - me.y, bestX - me.x);
            if (CFG.aimbot.smooth < 1) {
                var diff = targetAngle - aimAngle;
                while (diff > Math.PI) diff -= TAU;
                while (diff < -Math.PI) diff += TAU;
                aimAngle += diff * CFG.aimbot.smooth;
            } else { aimAngle = targetAngle; }
        } else { hasAimTarget = false; aimTargetId = -1; }
    }

    // === MELEE LOCK ===
    // Chase + aim + attack is now ALL handled inside cheatUpdate() Layer 1
    // by directly setting this.movement, this.rotation, this.attacking
    // simulateKey() was removed because the game rejects untrusted KeyboardEvents (isTrusted check)
    function updateMeleeLock() {
        // No-op: everything is handled in cheatUpdate now
    }

    // === MOUSE TRACKING ===
    // Track mouse via multiple methods for maximum reliability
    // Method 1: capture-phase pointer events on document
    document.addEventListener("pointerdown", function(e) {
        if (e.button === 0) {
            mouseIsDown = true;
            console.log("%c[CHEAT] pointerdown captured, mouseIsDown=true", "color:cyan");
        }
    }, true);
    document.addEventListener("pointerup", function(e) {
        if (e.button === 0) {
            mouseIsDown = false;
        }
    }, true);
    document.addEventListener("pointerleave", function(e) { mouseIsDown = false; }, true);
    // Method 2: also track via mousedown/mouseup as fallback
    document.addEventListener("mousedown", function(e) {
        if (e.button === 0) mouseIsDown = true;
    }, true);
    document.addEventListener("mouseup", function(e) {
        if (e.button === 0) mouseIsDown = false;
    }, true);

    // === X-RAY ===
    function applyXray() {
        if (!CFG.xray.enabled || !gameRef) return;
        try {
            var buildings = gameRef.objects && gameRef.objects.getCategory ? gameRef.objects.getCategory(CAT_BUILDING) : null;
            if (buildings) {
                for (var b of buildings) {
                    if (b.ceilingContainer && b.ceilingContainer.alpha > 0) {
                        b.ceilingContainer.alpha = 0; b.ceilingVisible = false;
                        if (xrayHiddenElements.indexOf(b) === -1) xrayHiddenElements.push(b);
                        if (b.ceilingTween) { try { b.ceilingTween.kill(); } catch(x){} b.ceilingTween = undefined; }
                    }
                }
            }
            var obstacles = gameRef.objects && gameRef.objects.getCategory ? gameRef.objects.getCategory(CAT_OBSTACLE) : null;
            if (obstacles) {
                for (var o of obstacles) {
                    if (o.ceilingContainer && o.ceilingContainer.alpha > 0) {
                        o.ceilingContainer.alpha = 0;
                        if (xrayHiddenElements.indexOf(o) === -1) xrayHiddenElements.push(o);
                    }
                }
            }
        } catch (e) {}
    }
    function restoreXray() {
        for (var i = 0; i < xrayHiddenElements.length; i++) {
            try { var obj = xrayHiddenElements[i]; if (obj.ceilingContainer) { obj.ceilingContainer.alpha = 1; obj.ceilingVisible = true; } } catch (e) {}
        }
        xrayHiddenElements = [];
    }

    // === ZOOM ===
    function applyZoom() {
        if (!CFG.zoom.enabled || !cameraRef) return;
        try {
            if (zoomBaseValue === null) zoomBaseValue = cameraRef.zoom;
            var target = zoomBaseValue * CFG.zoom.level;
            if (Math.abs(cameraRef.zoom - target) > 0.01) cameraRef.zoom = target;
        } catch (e) {}
    }
    function resetZoom() {
        if (cameraRef && zoomBaseValue !== null) { try { cameraRef.zoom = zoomBaseValue; } catch(e){} }
        zoomBaseValue = null;
    }

    // === SCAN SPECIAL OBSTACLES ===
    function scanSpecialObstacles() {
        if (!gameRef) return;
        var now = Date.now();
        if (now - lastObstacleScan < 3000) return;
        lastObstacleScan = now;
        var obstacles = gameRef.objects && gameRef.objects.getCategory ? gameRef.objects.getCategory(CAT_OBSTACLE) : null;
        if (!obstacles) return;
        tangoCratePositions = []; goldRockPositions = [];
        for (var o of obstacles) {
            var id = o.definition ? o.definition.idString : null;
            if (id === "tango_crate") tangoCratePositions.push({ x: o.position.x, y: o.position.y });
            else if (id === "gold_rock") goldRockPositions.push({ x: o.position.x, y: o.position.y });
        }
        // All tango crates and gold rocks are shown, no distance/visibility check
    }

    // === MAP MARKERS (minimap + full map unified) ===
    function renderMapMarkers() {
        var clip = getMapClipRect();
        if (!clip) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
        var killLeaderId = getKillLeaderId();
        var enemies = getEnemyPlayers();

        // Enemy dots (show all enemies on map, no distance/visibility check)
        if (CFG.map.enemyDots) {
            var playerSet = gameRef && gameRef.objects && gameRef.objects.getCategory ? gameRef.objects.getCategory(CAT_PLAYER) : null;
            if (playerSet) {
                for (var i = 0; i < playerSet.length; i++) {
                    var p = playerSet[i];
                    if (p.id === getMyId()) continue;
                    if (p.dead || p.downed) continue;
                    var isKL = (p.id === killLeaderId && CFG.map.killLeaderDot);
                    var col = isKL ? CFG.map.killLeaderColor : CFG.map.enemyColor;
                    var sz = isKL ? CFG.map.dotSize + 2 : CFG.map.dotSize;
                    var pos = worldToMapScreen(p.position.x, p.position.y);
                    if (!pos) continue;
                    ctx.beginPath(); ctx.arc(pos.x, pos.y, sz, 0, TAU);
                    ctx.fillStyle = col; ctx.fill();
                    ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke();
                    if (isKL) {
                        ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
                        ctx.fillStyle = CFG.map.killLeaderColor;
                        ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5;
                        ctx.strokeText("\u2605", pos.x, pos.y - sz - 3);
                        ctx.fillText("\u2605", pos.x, pos.y - sz - 3);
                    }
                    var nm = getPlayerName(p.id);
                    if (nm) {
                        ctx.font = "bold 7px sans-serif"; ctx.textAlign = "center";
                        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5;
                        var ly = isKL ? pos.y - sz - 12 : pos.y - sz - 3;
                        ctx.strokeText(nm, pos.x, ly); ctx.fillText(nm, pos.x, ly);
                    }
                }
            }
        }

        // Kill leader if teammate (not drawn as enemy)
        if (CFG.map.killLeaderDot && killLeaderId >= 0 && killLeaderId !== getMyId()) {
            var playerSet = gameRef && gameRef.objects && gameRef.objects.getCategory ? gameRef.objects.getCategory(CAT_PLAYER) : null;
            if (playerSet) {
                for (var p2 of playerSet) {
                    if (p2.id === killLeaderId && !p2.dead && !p2.downed) {
                        var myTeam2 = getMyTeamId();
                        var isEnemy = !(myTeam2 >= 0 && (p2.teamID === undefined ? -1 : p2.teamID) === myTeam2);
                        if (!isEnemy || !CFG.map.enemyDots) {
                            var pos2 = worldToMapScreen(p2.position.x, p2.position.y);
                            if (pos2) {
                                ctx.beginPath(); ctx.arc(pos2.x, pos2.y, CFG.map.dotSize + 2, 0, TAU);
                                ctx.fillStyle = CFG.map.killLeaderColor; ctx.fill();
                                ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke();
                                ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
                                ctx.fillStyle = CFG.map.killLeaderColor;
                                ctx.fillText("\u2605", pos2.x, pos2.y - CFG.map.dotSize - 5);
                            }
                        }
                        break;
                    }
                }
            }
        }

        // Tango crate markers — BIG visible pulsing diamond
        if (CFG.map.tangoCrates) {
            for (var t = 0; t < tangoCratePositions.length; t++) {
                var tc = tangoCratePositions[t];
                var tpos = worldToMapScreen(tc.x, tc.y);
                if (!tpos) continue;
                var tSz = 12; // big marker size
                // Outer glow
                ctx.beginPath();
                ctx.moveTo(tpos.x, tpos.y - tSz - 4);
                ctx.lineTo(tpos.x + tSz + 4, tpos.y);
                ctx.lineTo(tpos.x, tpos.y + tSz + 4);
                ctx.lineTo(tpos.x - tSz - 4, tpos.y);
                ctx.closePath();
                ctx.fillStyle = "rgba(155, 89, 182, 0.35)"; ctx.fill();
                // Inner diamond
                ctx.beginPath();
                ctx.moveTo(tpos.x, tpos.y - tSz);
                ctx.lineTo(tpos.x + tSz, tpos.y);
                ctx.lineTo(tpos.x, tpos.y + tSz);
                ctx.lineTo(tpos.x - tSz, tpos.y);
                ctx.closePath();
                ctx.fillStyle = CFG.map.tangoColor; ctx.fill();
                ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
                // Label
                ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
                ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
                ctx.strokeText("TANGO", tpos.x, tpos.y - tSz - 6);
                ctx.fillText("TANGO", tpos.x, tpos.y - tSz - 6);
            }
        }

        // Gold rock / Mosin markers — BIG visible square with label
        if (CFG.map.goldRocks) {
            for (var g = 0; g < goldRockPositions.length; g++) {
                var gr = goldRockPositions[g];
                var gpos = worldToMapScreen(gr.x, gr.y);
                if (!gpos) continue;
                var gSz = 10; // big marker half-size
                // Outer glow
                ctx.fillStyle = "rgba(233, 30, 140, 0.35)";
                ctx.fillRect(gpos.x - gSz - 3, gpos.y - gSz - 3, (gSz + 3) * 2, (gSz + 3) * 2);
                // Inner square
                ctx.fillStyle = CFG.map.goldRockColor;
                ctx.fillRect(gpos.x - gSz, gpos.y - gSz, gSz * 2, gSz * 2);
                ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
                ctx.strokeRect(gpos.x - gSz, gpos.y - gSz, gSz * 2, gSz * 2);
                // Label
                ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
                ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
                ctx.strokeText("GOLD", gpos.x, gpos.y - gSz - 6);
                ctx.fillText("GOLD", gpos.x, gpos.y - gSz - 6);
            }
        }

        ctx.restore();
    }

    // === ESP RENDERING ===
    function renderESP() {
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        if (!gameRef) return;
        var screenCX = overlay.width / 2;
        var screenCY = overlay.height / 2;
        var me = getMyPos();
        var myId = getMyId();
        var myTeam = getMyTeamId();
        var playerSet = gameRef.objects && gameRef.objects.getCategory ? gameRef.objects.getCategory(CAT_PLAYER) : null;

        if (CFG.esp.enabled && playerSet) {
            for (var p of playerSet) {
                if (p.id === myId) continue;
                if (p.dead || p.downed) continue;
                var isTeam = myTeam >= 0 && (p.teamID === undefined ? -1 : p.teamID) === myTeam;
                var color = isTeam ? CFG.esp.teamColor : CFG.esp.enemyColor;
                var sc = worldToScreen(p.position.x, p.position.y);
                var sx = sc.sx, sy = sc.sy, scale = sc.scale;
                if (sx < -200 || sx > overlay.width + 200 || sy < -200 || sy > overlay.height + 200) continue;
                var boxSize = 30 * scale;

                if (CFG.esp.boxes) {
                    ctx.strokeStyle = color; ctx.lineWidth = 2;
                    ctx.strokeRect(sx - boxSize / 2, sy - boxSize, boxSize, boxSize * 1.5);
                    var cc = 6; ctx.lineWidth = 3; ctx.beginPath();
                    ctx.moveTo(sx - boxSize/2, sy - boxSize + cc); ctx.lineTo(sx - boxSize/2, sy - boxSize); ctx.lineTo(sx - boxSize/2 + cc, sy - boxSize);
                    ctx.moveTo(sx + boxSize/2 - cc, sy - boxSize); ctx.lineTo(sx + boxSize/2, sy - boxSize); ctx.lineTo(sx + boxSize/2, sy - boxSize + cc);
                    ctx.moveTo(sx - boxSize/2, sy + boxSize/2 - cc); ctx.lineTo(sx - boxSize/2, sy + boxSize/2); ctx.lineTo(sx - boxSize/2 + cc, sy + boxSize/2);
                    ctx.moveTo(sx + boxSize/2 - cc, sy + boxSize/2); ctx.lineTo(sx + boxSize/2, sy + boxSize/2); ctx.lineTo(sx + boxSize/2, sy + boxSize/2 - cc);
                    ctx.stroke();
                }

                if (CFG.esp.tracers) {
                    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = 0.6;
                    ctx.beginPath(); ctx.moveTo(screenCX, screenCY); ctx.lineTo(sx, sy); ctx.stroke();
                    ctx.globalAlpha = 1;
                }

                if (CFG.esp.names) {
                    var name = getPlayerName(p.id) || ("Player " + p.id);
                    ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
                    ctx.fillStyle = color; ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
                    ctx.strokeText(name, sx, sy - boxSize - 8); ctx.fillText(name, sx, sy - boxSize - 8);
                }

                var dist = Math.round(Math.hypot(p.position.x - me.x, p.position.y - me.y));
                ctx.font = "10px sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#fff";
                ctx.fillText(dist + "m", sx, sy + boxSize / 2 + 14);

                if (p.id === aimTargetId && (CFG.aimbot.enabled || CFG.meleeLock.enabled)) {
                    ctx.strokeStyle = "#ff0"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
                    var tbs = boxSize * 1.3;
                    ctx.strokeRect(sx - tbs / 2, sy - tbs, tbs, tbs * 1.5);
                    ctx.setLineDash([]);
                    ctx.font = "bold 10px sans-serif"; ctx.fillStyle = "#ff0";
                    ctx.fillText("\u2295 TARGET", sx, sy - boxSize - 20);
                }
            }
        }

        // Loot ESP
        if (CFG.esp.enabled && CFG.esp.loot) {
            var lootSet = gameRef.objects && gameRef.objects.getCategory ? gameRef.objects.getCategory(CAT_LOOT) : null;
            if (lootSet) {
                for (var l of lootSet) {
                    var ld = Math.hypot(l.position.x - me.x, l.position.y - me.y);
                    if (ld > CFG.esp.lootRange) continue;
                    var lsc = worldToScreen(l.position.x, l.position.y);
                    if (lsc.sx < -50 || lsc.sx > overlay.width + 50 || lsc.sy < -50 || lsc.sy > overlay.height + 50) continue;
                    var dname = (l.definition && l.definition.idString ? l.definition.idString : "???").replace(/_/g, " ");
                    ctx.font = "9px sans-serif"; ctx.textAlign = "center";
                    ctx.fillStyle = CFG.esp.lootColor; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5;
                    ctx.strokeText(dname, lsc.sx, lsc.sy - 8); ctx.fillText(dname, lsc.sx, lsc.sy - 8);
                    ctx.fillStyle = CFG.esp.lootColor; ctx.beginPath();
                    ctx.moveTo(lsc.sx, lsc.sy - 4); ctx.lineTo(lsc.sx + 3, lsc.sy);
                    ctx.lineTo(lsc.sx, lsc.sy + 4); ctx.lineTo(lsc.sx - 3, lsc.sy);
                    ctx.closePath(); ctx.fill();
                }
            }
        }

        // Aimbot line
        if (CFG.aimbot.showLine && hasAimTarget) {
            var asc = worldToScreen(aimTargetX, aimTargetY);
            ctx.strokeStyle = CFG.aimbot.lineColor; ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]); ctx.beginPath();
            ctx.moveTo(screenCX, screenCY); ctx.lineTo(asc.sx, asc.sy);
            ctx.stroke(); ctx.setLineDash([]);
            ctx.strokeStyle = CFG.aimbot.lineColor; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(asc.sx, asc.sy, 10, 0, TAU); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(asc.sx - 13, asc.sy); ctx.lineTo(asc.sx + 13, asc.sy);
            ctx.moveTo(asc.sx, asc.sy - 13); ctx.lineTo(asc.sx, asc.sy + 13);
            ctx.stroke();
        }

        renderMapMarkers();
    }

    // === UI PANEL ===
    var uiPanel = document.createElement("div");
    uiPanel.id = "cheat-ui-panel";
    uiPanel.style.cssText = "position:fixed;top:10px;right:10px;z-index:99999999;background:linear-gradient(135deg,rgba(15,15,25,0.95),rgba(30,10,40,0.95));border:2px solid #ff2040;border-radius:10px;padding:12px 16px;min-width:240px;font-family:'Segoe UI',sans-serif;color:#eee;box-shadow:0 0 20px rgba(255,32,64,0.4),inset 0 0 30px rgba(0,0,0,0.3);user-select:none;cursor:default;max-height:90vh;overflow-y:auto;";

    // FIX: prevent panel from stealing focus from game canvas
    uiPanel.addEventListener("mousedown", function(e) {
        if (e.target.tagName === "INPUT" && e.target.type === "range") return;
        e.preventDefault();
    }, true);
    uiPanel.addEventListener("click", function() {
        requestAnimationFrame(function() {
            var gc = document.querySelector("#game canvas") || document.querySelector("canvas");
            if (gc) gc.focus();
        });
    }, true);

    var panelDragging = false, panelOffX = 0, panelOffY = 0;
    uiPanel.addEventListener("mousedown", function(e) {
        if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
        panelDragging = true;
        panelOffX = e.clientX - uiPanel.offsetLeft;
        panelOffY = e.clientY - uiPanel.offsetTop;
    });
    document.addEventListener("mousemove", function(e) {
        if (!panelDragging) return;
        uiPanel.style.left = (e.clientX - panelOffX) + "px";
        uiPanel.style.top = (e.clientY - panelOffY) + "px";
        uiPanel.style.right = "auto";
    });
    document.addEventListener("mouseup", function() { panelDragging = false; });

    function makeToggle(label, isOn, onClick) {
        var row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin:3px 0;";
        var lbl = document.createElement("span");
        lbl.textContent = label;
        lbl.style.cssText = "font-size:13px;color:#ddd;";
        var btn = document.createElement("button");
        btn.style.cssText = "min-width:50px;padding:3px 10px;border:none;border-radius:14px;font-size:12px;font-weight:bold;cursor:pointer;transition:all 0.15s;";
        btn.tabIndex = -1;
        function upd(on) {
            btn.textContent = on ? "ON" : "OFF";
            btn.style.background = on ? "linear-gradient(135deg,#00cc44,#00ff66)" : "linear-gradient(135deg,#cc2200,#ff3344)";
            btn.style.color = on ? "#002200" : "#fff";
            btn.style.boxShadow = on ? "0 0 8px rgba(0,255,100,0.5)" : "0 0 8px rgba(255,50,50,0.3)";
        }
        upd(isOn);
        btn.addEventListener("click", function(e) { e.stopPropagation(); upd(onClick()); });
        row.appendChild(lbl); row.appendChild(btn);
        return row;
    }

    function makeSlider(label, min, max, step, val, onChange) {
        var row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin:3px 0;";
        var lbl = document.createElement("span");
        lbl.textContent = label;
        lbl.style.cssText = "font-size:13px;color:#ddd;min-width:60px;";
        var s = document.createElement("input");
        s.type = "range"; s.min = min; s.max = max; s.step = step; s.value = val;
        s.style.cssText = "flex:1;margin:0 8px;accent-color:#ff2040;cursor:pointer;";
        s.tabIndex = -1;
        var v = document.createElement("span");
        v.textContent = Number(val).toFixed(1);
        v.style.cssText = "font-size:12px;color:#ff8;min-width:30px;text-align:right;";
        s.addEventListener("input", function(e) {
            e.stopPropagation();
            v.textContent = Number(s.value).toFixed(1);
            onChange(parseFloat(s.value));
        });
        row.appendChild(lbl); row.appendChild(s); row.appendChild(v);
        return row;
    }

    function addSection(parent, name) {
        var s = document.createElement("div");
        s.textContent = name;
        s.style.cssText = "font-size:11px;color:#ff8040;margin-top:8px;margin-bottom:2px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid rgba(255,128,64,0.3);padding-bottom:2px;";
        parent.appendChild(s);
    }

    function buildUI() {
        uiPanel.innerHTML = "";
        var title = document.createElement("div");
        title.innerHTML = "\u{1F3AE} <b>SUROI ULTIMATE v3</b>";
        title.style.cssText = "text-align:center;font-size:16px;color:#ff2040;margin-bottom:6px;text-shadow:0 0 10px rgba(255,32,64,0.6);border-bottom:1px solid rgba(255,255,255,0.15);padding-bottom:4px;";
        uiPanel.appendChild(title);
        var hint = document.createElement("div");
        hint.textContent = "Press \\ to hide/show";
        hint.style.cssText = "text-align:center;font-size:10px;color:#888;margin-bottom:6px;";
        uiPanel.appendChild(hint);

        addSection(uiPanel, "\u{1F441}\uFE0F ESP");
        uiPanel.appendChild(makeToggle("ESP", CFG.esp.enabled, function() { return (CFG.esp.enabled = !CFG.esp.enabled); }));
        uiPanel.appendChild(makeToggle("Boxes", CFG.esp.boxes, function() { return (CFG.esp.boxes = !CFG.esp.boxes); }));
        uiPanel.appendChild(makeToggle("Tracers", CFG.esp.tracers, function() { return (CFG.esp.tracers = !CFG.esp.tracers); }));
        uiPanel.appendChild(makeToggle("Names", CFG.esp.names, function() { return (CFG.esp.names = !CFG.esp.names); }));
        uiPanel.appendChild(makeToggle("Loot ESP", CFG.esp.loot, function() { return (CFG.esp.loot = !CFG.esp.loot); }));

        addSection(uiPanel, "\u{1F3AF} AIMBOT");
        uiPanel.appendChild(makeToggle("Aimbot", CFG.aimbot.enabled, function() { return (CFG.aimbot.enabled = !CFG.aimbot.enabled); }));
        uiPanel.appendChild(makeToggle("Aim Lines", CFG.aimbot.showLine, function() { return (CFG.aimbot.showLine = !CFG.aimbot.showLine); }));
        uiPanel.appendChild(makeToggle("Auto-Fire (Aim)", CFG.aimbot.autoFire, function() { return (CFG.aimbot.autoFire = !CFG.aimbot.autoFire); }));

        addSection(uiPanel, "\u{1F52B} AUTO-FIRE");
        uiPanel.appendChild(makeToggle("Full-Auto All", CFG.autoFire.enabled, function() { return (CFG.autoFire.enabled = !CFG.autoFire.enabled); }));

        addSection(uiPanel, "\u{1F94A} MELEE LOCK");
        uiPanel.appendChild(makeToggle("Melee Lock", CFG.meleeLock.enabled, function() { return (CFG.meleeLock.enabled = !CFG.meleeLock.enabled); }));

        addSection(uiPanel, "\u{1F3E0} X-RAY");
        uiPanel.appendChild(makeToggle("X-Ray", CFG.xray.enabled, function() {
            CFG.xray.enabled = !CFG.xray.enabled;
            if (!CFG.xray.enabled) restoreXray();
            return CFG.xray.enabled;
        }));

        addSection(uiPanel, "\u{1F50D} ZOOM HACK");
        uiPanel.appendChild(makeToggle("Zoom Hack", CFG.zoom.enabled, function() {
            CFG.zoom.enabled = !CFG.zoom.enabled;
            if (!CFG.zoom.enabled) resetZoom();
            return CFG.zoom.enabled;
        }));
        uiPanel.appendChild(makeSlider("Level", CFG.zoom.min, CFG.zoom.max, CFG.zoom.step, CFG.zoom.level, function(v) { CFG.zoom.level = v; }));

        addSection(uiPanel, "\u{1F5FA}\uFE0F MAP MARKERS");
        uiPanel.appendChild(makeToggle("Enemy Dots", CFG.map.enemyDots, function() { return (CFG.map.enemyDots = !CFG.map.enemyDots); }));
        uiPanel.appendChild(makeToggle("Kill Leader", CFG.map.killLeaderDot, function() { return (CFG.map.killLeaderDot = !CFG.map.killLeaderDot); }));
        uiPanel.appendChild(makeToggle("Tango Crates", CFG.map.tangoCrates, function() { return (CFG.map.tangoCrates = !CFG.map.tangoCrates); }));
        uiPanel.appendChild(makeToggle("Gold Rocks", CFG.map.goldRocks, function() { return (CFG.map.goldRocks = !CFG.map.goldRocks); }));

        var legend = document.createElement("div");
        legend.style.cssText = "margin-top:8px;font-size:10px;color:#999;line-height:1.6;";
        legend.innerHTML = '<span style="color:' + CFG.map.enemyColor + '">\u25CF</span> Enemy &nbsp;<span style="color:' + CFG.map.killLeaderColor + '">\u2605</span> Kill Leader<br><span style="color:' + CFG.map.tangoColor + '">\u25C6</span> Tango Crate &nbsp;<span style="color:' + CFG.map.goldRockColor + '">\u25A0</span> Gold Rock';
        uiPanel.appendChild(legend);
    }

    buildUI();
    document.body.appendChild(uiPanel);

    // === MAIN LOOP ===
    // NOTE: updateMeleeLock is now a no-op; chase/aim/attack all live in cheatUpdate
    function tick() {
        findAimTarget();
        updateMeleeLock();
        logDebugState();
        if (CFG.xray.enabled) applyXray();
        if (CFG.zoom.enabled) applyZoom();
        scanSpecialObstacles();
        renderESP();
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    // === KEYBINDS ===
    document.addEventListener("keydown", function(e) {
        if (e.key === "\\") {
            e.preventDefault();
            CFG.ui.visible = !CFG.ui.visible;
            uiPanel.style.display = CFG.ui.visible ? "block" : "none";
        }
    });

    // === CLEANUP ===
    window.__cheatCleanup = function() {
        overlay.remove();
        uiPanel.remove();
        restoreXray();
        resetZoom();
        console.log("%c[CHEAT] Cleaned up! Refresh to fully restore.", "color:red;font-weight:bold");
    };

    console.log("%c[CHEAT] SUROI ULTIMATE v3 LOADED", "color:#ff2040;font-size:16px;font-weight:bold");
    console.log("%c  \\  = Toggle UI Panel", "color:#0f0;font-size:12px");
    console.log("%c  Aimbot+AutoFire via InputManager monkey-patch", "color:#0f0;font-size:12px");
    console.log("%c  Map: enemies + kill leader + tango + mosin", "color:#0f0;font-size:12px");
    console.log("%c  __cheatCleanup() to remove", "color:#ff0;font-size:12px");
})();
