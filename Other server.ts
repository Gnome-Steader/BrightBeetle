#!/usr/bin/env bun

/**
 * CRACKED Ultra-Aggressive AI Bot Spawner for Suroi — REMOTE SERVER EDITION
 *
 * Usage: bun "Other server.ts" [region] [number of bots]
 *
 * Regions: na (North America), eu (Europe), sa (South America), as (Asia), oc (Oceania)
 *          Or pass a custom URL: bun "Other server.ts" https://my-suroi.example.com 10
 *
 * Examples:
 *   bun "Other server.ts" na 20       → 20 bots on North America suroi.io
 *   bun "Other server.ts" eu 5        → 5 bots on Europe suroi.io
 *   bun "Other server.ts"             → 10 bots on North America (default)
 *   bun "Other server.ts" https://custom.server.com 15  → 15 bots on custom server
 *
 * KEY BEHAVIORS:
 *   🔴 Gas avoidance: NEVER die to gas — stay inside safe zone, pre-move to new zone 5s before gas advances.
 *   💀 Combat: chase players, use GUNS at range, switch to FISTS at close range.
 *   🪨 Crates: equip melee, walk to crate, PUNCH it (attacking=true breaks crates).
 *   🚪 Doors: use InputActions.Interact to open doors while moving.
 *   📦 Loot: auto-pickup items nearby with Interact/Loot actions.
 *   🧱 Walls: stuck detection → equip melee + punch + try 8 escape directions.
 */

import { PacketDataIn, PacketDataOut, PacketType } from "./common/src/packets/packet";
import { FireMode, GasState, InputActions, ObjectCategory } from "./common/src/constants";
import { HealingItems } from "./common/src/definitions/items/healingItems";
import { Guns }         from "./common/src/definitions/items/guns";
import { Melees }       from "./common/src/definitions/items/melees";
import { Throwables }   from "./common/src/definitions/items/throwables";
import { Skins, type SkinDefinition } from "./common/src/definitions/items/skins";
import { Obstacles } from "./common/src/definitions/obstacles";
import { Scopes }       from "./common/src/definitions/items/scopes";
import { InputPacket, areDifferent, type InputData } from "./common/src/packets/inputPacket";
import { JoinPacket }   from "./common/src/packets/joinPacket";
import { PacketStream } from "./common/src/packets/packetStream";
import { Geometry, π, τ } from "./common/src/utils/math";
import { type ReferenceTo }  from "./common/src/utils/objectDefinitions";
import { type FullData }     from "./common/src/utils/objectsSerializations";
import { pickRandomInArray, random, randomBoolean, randomSign } from "./common/src/utils/random";
import { Vec, type Vector } from "./common/src/utils/vector";

// ─────────────────────────── Config ──────────────────────────────────────────

// Known suroi.io regions
const REGIONS: Record<string, { mainAddress: string; gameAddress: string; offset: number }> = {
    na: { mainAddress: "https://na.suroi.io", gameAddress: "wss://na.suroi.io/game/<gameID>", offset: 1 },
    eu: { mainAddress: "https://eu.suroi.io", gameAddress: "wss://eu.suroi.io/game/<gameID>", offset: 1 },
    sa: { mainAddress: "https://sa.suroi.io", gameAddress: "wss://sa.suroi.io/game/<gameID>", offset: 1 },
    as: { mainAddress: "https://as.suroi.io", gameAddress: "wss://as.suroi.io/game/<gameID>", offset: 1 },
    oc: { mainAddress: "https://oc.suroi.io", gameAddress: "wss://oc.suroi.io/game/<gameID>", offset: 1 },
};

// Parse CLI args: [region/url] [botCount]
const arg1 = process.argv[2] ?? "na";
const arg2 = process.argv[3];

let mainAddress: string;
let gameAddress: string;
let offset: number;
let botCount: number;

if (REGIONS[arg1]) {
    // Known region shorthand
    const region = REGIONS[arg1];
    mainAddress = region.mainAddress;
    gameAddress = region.gameAddress;
    offset      = region.offset;
    botCount    = parseInt(arg2) || 10;
    console.log(`🌍 Region: ${arg1.toUpperCase()} (${mainAddress})`);
} else if (arg1.startsWith("http://") || arg1.startsWith("https://")) {
    // Custom URL — derive WS address from HTTP address
    const wsUrl = arg1.replace("http://", "ws://").replace("https://", "wss://");
    mainAddress = arg1;
    gameAddress = `${wsUrl}/game/<gameID>`;
    offset      = 1;
    botCount    = parseInt(arg2) || 10;
    console.log(`🌍 Custom server: ${mainAddress}`);
} else {
    // Maybe arg1 is the botCount and user wants default region
    botCount    = parseInt(arg1) || 10;
    const region = REGIONS["na"];
    mainAddress = region.mainAddress;
    gameAddress = region.gameAddress;
    offset      = region.offset;
    console.log(`🌍 Region: NA (default) — ${mainAddress}`);
}

const config = {
    mainAddress,
    gameAddress,
    offset,
    botCount,
    joinDelay:     200,       // Slightly slower join to avoid rate limits on remote servers
    rejoinOnDeath: false
};

console.log(`🔥 Starting ${config.botCount} CRACKED bots on remote server...`);

// ─────────────────────────── Healing items ───────────────────────────────────

const MEDIKIT = HealingItems.reify("medikit");
const GAUZE   = HealingItems.reify("gauze");
const COLA    = HealingItems.reify("cola");
const TABLETS = HealingItems.reify("tablets");

// ─────────────────────────── Scope helper ────────────────────────────────────

function scopeZoom(id: string): number {
    return Scopes.fromStringSafe(id)?.zoomLevel ?? 70;
}

// ─────────────────────────── Weapon profiles ─────────────────────────────────

interface WeaponProfile {
    dps:         number;
    isShotgun:   boolean;
    isSniper:    boolean;
    isMelee:     boolean;
    isThrowable: boolean;
    isAuto:      boolean;
    range:       number;
    fireDelayMs: number;
}

const WEAPON_DB = new Map<string, WeaponProfile>();

for (const gun of Guns.definitions) {
    const b  = gun.ballistics;
    const bc = (gun as any).bulletCount ?? 1;
    const dps = (b.damage * bc) / (gun.fireDelay / 1000);
    const isSniper  = b.range >= 220;
    const isShotgun = b.range <= 90 && bc >= 7;
    const isAuto = gun.fireMode === FireMode.Auto;
    WEAPON_DB.set(gun.idString, { dps, isShotgun, isSniper, isMelee: false, isThrowable: false, isAuto, range: b.range, fireDelayMs: gun.fireDelay });
}

for (const m of Melees.definitions) {
    const meleeIsAuto = m.fireMode === FireMode.Auto;
    WEAPON_DB.set(m.idString, {
        dps: m.damage / (m.cooldown / 1000),
        isShotgun: false, isSniper: false, isMelee: true, isThrowable: false, isAuto: meleeIsAuto, range: 5, fireDelayMs: m.cooldown
    });
}

for (const th of Throwables.definitions) {
    WEAPON_DB.set(th.idString, {
        dps: th.impactDamage ?? 5,
        isShotgun: false, isSniper: false, isMelee: false, isThrowable: true, isAuto: false, range: 35, fireDelayMs: 500
    });
}

const isMeleeId  = (id: string) => WEAPON_DB.get(id)?.isMelee    ?? false;
const isRangedId = (id: string) => { const p = WEAPON_DB.get(id); return !!p && !p.isMelee && !p.isThrowable; };

const CRATE_IDS     = /crate|box|barrel|hazel|briefcase|cooler|fridge|washing|toilet|stove|bookshelf|table|chair|drawer|filing|piano|bed|couch|tv|vending|gun_mount/i;
// Target breakable containers for loot — EXCLUDE explosive things (barrels, stoves, propane tanks)
const LOOT_CRATE_IDS = /crate|box|hazel|briefcase|cooler|fridge|washing|toilet|bookshelf|table|chair|drawer|filing|piano|bed|couch|tv|vending|gun_mount/i;
const EXPLOSIVE_IDS  = /barrel|super_barrel|loot_barrel|propane|stove|control_panel|coal/i;
const GRENADE_IDS   = new Set(["frag_grenade", "smoke_grenade", "c4", "sm56", "confetti_grenade"]);

// ─────────────────────────── Global objects ───────────────────────────────────

interface ObjectData {
    position:      Vector;
    lastPosition?: Vector;
    type:          ObjectCategory;
    dead:          boolean;
    lastSeen:      number;
    idString:      string;
    name?:         string;
}

// Players with these names are never attacked
const PACIFIST_NAMES = new Set(["PLZ DON'T SHOOT"]);

const objects    = new Map<number, ObjectData>();
let   globalTick = 0;
const bots: Bot[] = [];
let allBotsJoined = false;

// ─────────────────────────── Helpers ─────────────────────────────────────────

function angleDiff(a: number, b: number): number {
    let d = a - b;
    while (d >  π) d -= τ;
    while (d < -π) d += τ;
    return d;
}
function lerpAngle(from: number, to: number, t: number): number {
    return from + angleDiff(to, from) * t;
}

// ─────────────────────────── Bot ─────────────────────────────────────────────

class Bot {
    readonly id:     number;
    readonly gameID: number;
    private _serverId?: number;

    // World position
    position = Vec(0, 0);
    private _prevPosition  = Vec(0, 0);  // for stuck detection

    // Stats
    private _health      = 100;
    private _lastHealth  = 100;
    private _adrenaline  = 0;
    private _ammo        = 0;

    // Inventory
    private _slot             = 0;
    private _requestedSlot    = -1;  // Track what slot we asked the server to equip
    private _activeWeaponId   = "";
    private _hasRangedWeapon  = false;
    private _scope            = "1x_scope";
    private _weapons: string[] = [];
    private _inventory: Record<string, number> = {};
    private _throwableCooldown = 0;
    private _grenadeSlot       = -1;
    private _emptyGunSlots: Set<number> = new Set();  // Gun slots known to have no ammo
    private _slotAmmoTicks     = 0;  // Ticks on current gun slot with 0 ammo

    // Attack toggling for single-fire weapons (non-auto guns & melee)
    // The server only fires on the rising edge (false→true transition) for single-fire weapons.
    // We must cycle attacking on/off to create repeated "click" events.
    private _attackCycleTick  = 0;   // Counts up each tick while attacking

    // Gas — the single most important state
    private _gasOld?: { position: Vector; radius: number };
    private _gasNew?: { position: Vector; radius: number };
    private _gasState:    GasState = GasState.Inactive;
    private _gasDuration: number   = 0;   // total seconds for current stage
    private _gasProgress: number   = 0;   // 0-1: how far through current stage

    /** Seconds remaining in the current gas stage */
    private get _gasSecondsLeft(): number {
        return Math.max(0, this._gasDuration * (1 - this._gasProgress));
    }

    // Combat
    private _angle         = random(-π, π);
    private _smoothedAngle = random(-π, π);
    private readonly _distToMouse = random(50, 130);
    private _takingDamage  = false;
    private _dodgeTimer    = 0;
    private _grenadeCookTimer = 0;  // Ticks remaining to cook grenade
    private _isCookingGrenade = false;

    // Crate tracking
    private _targetCrate?: number;
    private _crateFailTimer = 0;
    private _crackedCrates: Set<number> = new Set();

    // "Activated" flag — bots only attack crates AFTER being attacked once
    private _hasBeenAttacked = false;

    // Wall-blocked enemy tracking: if we're stuck trying to reach an enemy, skip them
    private _enemyStuckTimer  = 0;
    private _lastEnemyTarget?: number;
    private _blockedEnemies: Set<number> = new Set();
    private _blockedEnemyExpiry: Map<number, number> = new Map(); // tick when to unblock

    // Wall-blocked crate tracking: if stuck chasing a crate, skip it
    private _crateStuckTimer  = 0;
    private _lastCrateTarget?: number;
    private _blockedCrates: Set<number> = new Set();
    private _blockedCrateExpiry: Map<number, number> = new Map();

    // Roam direction (persistent so bots don't group up)
    private _roamAngle = random(-π, π);
    private _roamChangeTick = 0;

    // Nearby cache (vision-limited)
    private _nearbyObjects: number[] = [];
    private _tickCount = 0;
    private _moving = { up: false, down: false, left: false, right: false };

    // Network
    private _connected    = false;
    get connected():    boolean { return this._connected; }
    private _disconnected = false;
    get disconnected(): boolean { return this._disconnected; }

    private _deadPlayers: Set<number> = new Set();

    private readonly _ws:    WebSocket;
    private readonly _stream = new PacketStream(new ArrayBuffer(2048));
    private _lastInputPacket?: InputData;

    constructor(id: number, gameID: number) {
        this.id     = id;
        this.gameID = gameID;

        this._ws = new WebSocket(
            `${config.gameAddress.replace("<gameID>", (gameID + config.offset).toString())}/play`
        );
        this._ws.addEventListener("error", console.error);
        this._ws.addEventListener("open",  this._join.bind(this));
        this._ws.addEventListener("close", () => { this._disconnected = true; this._connected = false; });
        this._ws.binaryType = "arraybuffer";
        this._ws.onmessage = (msg: MessageEvent) => {
            const stream = new PacketStream(msg.data as ArrayBuffer);
            while (true) {
                try {
                    const p = stream.deserialize();
                    if (p === undefined) break;
                    this._onPacket(p);
                } catch { continue; }
            }
        };
    }

    // ── Vision limited to scope ───────────────────────────────────────────────

    get visionRange(): number { return scopeZoom(this._scope); }

    // ── Packet handling ───────────────────────────────────────────────────────

    private _onPacket(packet: PacketDataOut): void {
        const updatePos = (data: FullData<ObjectCategory>, id: number): void => {
            // Position can be at data.position (players/loot) or data.full.position (obstacles/buildings)
            const anyData = data as any;
            const position = anyData?.position ?? anyData?.full?.position;
            if (!position) return;
            const obj = objects.get(id);
            if (obj) {
                obj.lastPosition = { x: obj.position.x, y: obj.position.y };
                obj.position.x   = position.x;
                obj.position.y   = position.y;
                obj.lastSeen     = globalTick;
            }
            if (id === this._serverId) {
                this.position.x = position.x;
                this.position.y = position.y;
            }
        };

        switch (packet.type) {
            case PacketType.Kill: {
                // Kill feed: mark victim as dead immediately
                const killData = packet as any;
                if (killData.victimId !== undefined) {
                    this._deadPlayers.add(killData.victimId);
                    const obj = objects.get(killData.victimId);
                    if (obj) obj.dead = true;
                }
                break;
            }
            case PacketType.GameOver: {
                const kills = packet.teammates?.find(t => t.playerID === this.id)?.kills ?? 0;
                const cause = this._health <= 0 ? "GAS" : "COMBAT";
                console.log(`Bot ${this.id} ${packet.rank === 1 ? "🏆 WON" : `💀 died (${cause})`} | Kills: ${kills} | Rank: ${packet.rank} | Final HP: ${this._health}`);
                this._disconnected = true; this._connected = false; this._ws.close();
                break;
            }
            case PacketType.Update: {
                this._serverId ??= packet.playerData?.id?.id;

                const inv = packet.playerData?.inventory as any;
                if (inv) {
                    this._slot    = inv.activeWeaponIndex ?? this._slot;
                    if (inv.weapons) {
                        this._weapons    = (inv.weapons as any[]).map((w: any) => w?.definition?.idString ?? "");
                        this._grenadeSlot = this._weapons.findIndex(id => GRENADE_IDS.has(id));
                    }
                    const active = inv.weapons?.[this._slot];
                    this._activeWeaponId  = active?.definition?.idString ?? "";
                    this._hasRangedWeapon = isRangedId(this._activeWeaponId);
                    // Ammo = weapon count for active weapon slot
                    if (active?.count !== undefined) this._ammo = active.count;
                }

                // Items (healing, ammo counts, scope) are in a SEPARATE field from inventory
                const itemsData = packet.playerData?.items as any;
                if (itemsData?.items) {
                    for (const [k, v] of Object.entries(itemsData.items as Record<string, number>))
                        this._inventory[k] = v;
                }
                if (itemsData?.scope?.idString) this._scope = itemsData.scope.idString;

                if (packet.playerData?.health !== undefined) {
                    this._lastHealth = this._health;
                    // Health comes as a 0-1 float, scale to 0-100
                    this._health     = packet.playerData.health * 100;
                    if (this._health < this._lastHealth) { this._takingDamage = true; this._dodgeTimer = 40 + random(0, 20); }
                }
                if ((packet.playerData as any)?.adrenaline !== undefined)
                    // Adrenaline comes as a 0-1 float, scale to 0-100
                    this._adrenaline = (packet.playerData as any).adrenaline * 100;

                // ── Gas data ──────────────────────────────────────────────────
                if (packet.gas) {
                    this._gasOld = { position: packet.gas.oldPosition, radius: packet.gas.oldRadius };
                    this._gasNew = { position: packet.gas.newPosition, radius: packet.gas.newRadius };
                    this._gasState    = packet.gas.state;
                    this._gasDuration = packet.gas.currentDuration;
                }
                if (packet.gasProgress !== undefined) {
                    this._gasProgress = packet.gasProgress;
                }

                for (const { id, name } of packet.newPlayers ?? [])
                    objects.set(id, { position: Vec(0, 0), type: ObjectCategory.Player, lastSeen: globalTick, dead: false, idString: "", name });

                for (const { id, type, data } of packet.fullDirtyObjects ?? []) {
                    let obj = objects.get(id);
                    if (!obj) { obj = { position: Vec(0, 0), type, lastSeen: globalTick, dead: false, idString: "" }; objects.set(id, obj); }
                    obj.type = type;
                    const anyData = data as any;
                    // idString: try data.definition (players/loot), data.full.definition (obstacles/buildings), data.type (loot)
                    if (anyData?.full?.definition?.idString)       obj.idString = anyData.full.definition.idString;
                    else if (anyData?.definition?.idString)        obj.idString = anyData.definition.idString;
                    else if (anyData?.type?.idString)              obj.idString = anyData.type.idString;
                    // Detect dead/destroyed: Players have dead/downed in data.full, obstacles have dead at top level
                    if (type === ObjectCategory.Player) {
                        if (anyData?.full?.dead === true || anyData?.full?.downed === true) {
                            obj.dead = true;
                            this._deadPlayers.add(id);
                        }
                    } else if (anyData?.dead === true) {
                        obj.dead = true;
                    }
                    updatePos(data, id);
                }
                for (const { id, data } of packet.partialDirtyObjects ?? []) {
                    const anyData = data as any;
                    const obj = objects.get(id);
                    if (obj) {
                        // Players: check full.dead/full.downed
                        if (obj.type === ObjectCategory.Player && (anyData?.full?.dead === true || anyData?.full?.downed === true)) {
                            obj.dead = true;
                            this._deadPlayers.add(id);
                        }
                        // Obstacles: check top-level dead
                        if (anyData?.dead === true) obj.dead = true;
                    }
                    updatePos(data, id);
                }
                for (const id of packet.deletedObjects ?? []) {
                    const obj = objects.get(id);
                    if (obj) obj.dead = true;
                    objects.delete(id);
                }
                for (const id of packet.deletedPlayers ?? []) {
                    this._deadPlayers.add(id);
                    const obj = objects.get(id);
                    if (obj) obj.dead = true;
                    objects.delete(id);
                }

                // Kill feed comes as separate PacketType.Kill packets, handled above in the switch

                this._updateNearbyObjects();
                break;
            }
        }
    }

    private _updateNearbyObjects(): void {
        const rangeSq = this.visionRange ** 2;
        this._nearbyObjects = [];
        for (const [id, obj] of objects) {
            // NEVER include the bot itself, and skip dead things early
            if (id === this._serverId || obj.dead) continue;
            if (Geometry.distanceSquared(this.position, obj.position) <= rangeSq)
                this._nearbyObjects.push(id);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GAS DANGER ASSESSMENT — NEVER DIE TO GAS
    //
    // Philosophy:
    //   • Bots ALWAYS stay inside the current safe zone.
    //   • During the WAITING phase (gas hasn't started moving yet),
    //     bots are allowed to be outside the *future* safe zone ONLY
    //     if there are >5 seconds left before the gas starts advancing.
    //   • Once there are ≤5 seconds left in the waiting phase, or the
    //     gas is advancing, bots must already be inside the *new* safe zone.
    //   • If a bot is somehow in the gas already, flee with maximum urgency.
    // ═════════════════════════════════════════════════════════════════════════

    /** True when bot is already outside the current gas boundary — EMERGENCY */
    private _isInGas(): boolean {
        if (!this._gasOld) return false;
        return Geometry.distance(this.position, this._gasOld.position) >= this._gasOld.radius;
    }

    /** True when bot is in the outer 30% of the current safe zone — start heading inward */
    private _isNearGasEdge(): boolean {
        if (!this._gasOld) return false;
        const dist = Geometry.distance(this.position, this._gasOld.position);
        return dist > (this._gasOld.radius * 0.70);
    }

    /** True when bot is outside the FUTURE (new) safe zone */
    private _isOutsideFutureZone(): boolean {
        if (!this._gasNew) return false;
        return Geometry.distance(this.position, this._gasNew.position) > this._gasNew.radius * 0.80;
    }

    /** Always returns the safe-zone centre to flee toward — never null once gas data exists */
    private _gasFleeTarget(): Vector | null {
        if (this._gasNew) return this._gasNew.position;
        if (this._gasOld) return this._gasOld.position;
        return null;
    }

    /**
     * Combined check: bot must drop everything and flee to safety.
     *
     * Returns true in any of these cases:
     *   1. Bot is already in the gas (outside current zone) — EMERGENCY
     *   2. Bot is near the edge of the current zone (~outer 30%)
     *   3. Gas is ADVANCING and bot is outside the new (shrinking) zone
     *   4. Gas is WAITING but ≤5 seconds remain → get inside new zone NOW
     *   5. Bot is outside the new zone and gas isn't waiting (inactive edge case)
     */
    private _mustFleeGas(): boolean {
        // 1) Already in gas — always flee immediately
        if (this._isInGas()) return true;

        // 2) Near the edge of current safe zone — head inward
        if (this._isNearGasEdge()) return true;

        // 3) Gas is advancing — MUST be inside new zone
        if (this._gasState === GasState.Advancing && this._isOutsideFutureZone()) return true;

        // 4) Gas is waiting — flee to new zone if ≤5 seconds left before it advances
        if (this._gasState === GasState.Waiting) {
            const secsLeft = this._gasSecondsLeft;
            if (secsLeft <= 5 && this._isOutsideFutureZone()) return true;
        }

        // 5) Bot is outside new zone while gas isn't inactive (catch-all safety)
        if (this._gasState !== GasState.Inactive && this._isOutsideFutureZone()) {
            // Even during waiting with >5s left, if we're VERY far from new zone, start moving
            if (this._gasNew) {
                const distToNewCenter = Geometry.distance(this.position, this._gasNew.position);
                // If we'd need more than ~5 seconds of running to reach the edge, start now
                // Bot speed is roughly 12 units/sec → need (dist - radius) / 12 seconds
                const timeToReach = Math.max(0, distToNewCenter - this._gasNew.radius * 0.80) / 12;
                if (timeToReach > this._gasSecondsLeft - 3) return true;  // 3 second safety margin
            }
        }

        return false;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STUCK DETECTION — 3-phase escape: back up → side-step → resume
    //
    // Phase 0 (ticks 0-14):  REVERSE — move opposite to where we were heading
    // Phase 1 (ticks 15-29): SIDE-STEP — move perpendicular (left or right)
    // Phase 2 (ticks 30+):   RESUME — try original direction again
    //                        If still stuck after phase 2, flip side & restart
    // ═════════════════════════════════════════════════════════════════════════

    private _stuckTimer     = 0;
    private _stuckPhase     = 0;    // 0=reverse, 1=sidestep, 2=resume
    private _stuckPhaseTick = 0;
    private _alternateDir   = 1;    // 1 or -1 for which side to dodge
    private _lastMoveAngle  = 0;    // The direction we were trying to go when we got stuck

    private _isMoving(): boolean {
        return this._moving.up || this._moving.down || this._moving.left || this._moving.right;
    }

    /**
     * Call at the START of each tick (before deciding movement).
     * Returns true when bot is stuck (barely moved for 6+ ticks).
     */
    private _updateStuck(): boolean {
        const moved = Geometry.distance(this.position, this._prevPosition);
        this._prevPosition = { x: this.position.x, y: this.position.y };

        if (this._isMoving() && moved < 0.12) {
            this._stuckTimer++;
        } else {
            // Moving fine — reset everything
            this._stuckTimer     = 0;
            this._stuckPhase     = 0;
            this._stuckPhaseTick = 0;
        }

        if (this._stuckTimer < 6) return false;

        // We're stuck — advance phase ticks
        this._stuckPhaseTick++;

        if (this._stuckPhase === 0 && this._stuckPhaseTick > 15) {
            // Done reversing, start side-stepping
            this._stuckPhase = 1;
            this._stuckPhaseTick = 0;
        } else if (this._stuckPhase === 1 && this._stuckPhaseTick > 15) {
            // Done side-stepping, try resuming
            this._stuckPhase = 2;
            this._stuckPhaseTick = 0;
        } else if (this._stuckPhase === 2 && this._stuckPhaseTick > 20) {
            // Still stuck after resume — flip side direction and restart
            this._alternateDir *= -1;
            this._stuckPhase = 0;
            this._stuckPhaseTick = 0;
        }

        return true;
    }

    /** Apply the 3-phase stuck escape (back up → sidestep → resume) */
    private _applyStuckEscape(): void {
        const a = this._lastMoveAngle;
        if (this._stuckPhase === 0) {
            // Phase 0: REVERSE — go backwards
            this._setMoveFromAngle(a + π);
        } else if (this._stuckPhase === 1) {
            // Phase 1: SIDE-STEP — go perpendicular
            this._setMoveFromAngle(a + (π / 2) * this._alternateDir);
        } else {
            // Phase 2: RESUME — try original direction with slight offset
            this._setMoveFromAngle(a + (π / 6) * this._alternateDir);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────

    private _findNearestEnemy(): number | undefined {
        let best: number | undefined, bestD = Infinity;
        for (const id of this._nearbyObjects) {
            if (id === this._serverId) continue;
            // Triple-check dead: set, object flag, and re-verify
            if (this._deadPlayers.has(id)) continue;
            if (this._blockedEnemies.has(id)) continue;
            const obj = objects.get(id);
            if (!obj || obj.type !== ObjectCategory.Player) continue;
            // If obj is dead, add to dead set and skip
            if (obj.dead) { this._deadPlayers.add(id); continue; }
            // Never attack pacifist players
            if (obj.name && PACIFIST_NAMES.has(obj.name)) continue;
            const d = Geometry.distanceSquared(this.position, obj.position);
            if (d < bestD) { bestD = d; best = id; }
        }
        return best;
    }

    private _findNearestCrate(): number | undefined {
        let best: number | undefined, bestD = Infinity;
        const maxD = 120 ** 2;  // Large search range — crates are high priority
        for (const id of this._nearbyObjects) {
            const obj = objects.get(id);
            if (!obj || obj.type !== ObjectCategory.Obstacle || obj.dead) continue;
            // Skip already cracked crates
            if (this._crackedCrates.has(id)) continue;
            // Skip crates blocked by walls (stuck detection)
            if (this._blockedCrates.has(id)) continue;
            // NEVER target explosive obstacles (barrels, stoves, propane tanks)
            if (obj.idString && EXPLOSIVE_IDS.test(obj.idString)) continue;
            // NEVER target indestructible obstacles (walls, rocks, etc.)
            if (obj.idString) {
                const def = Obstacles.fromStringSafe(obj.idString);
                if (def?.indestructible) continue;
            }
            // If we know the idString, filter to breakable containers
            // If idString is empty (unknown object), still target it — it might be a crate
            if (obj.idString && !LOOT_CRATE_IDS.test(obj.idString)) continue;
            const d = Geometry.distanceSquared(this.position, obj.position);
            if (d < bestD && d < maxD) { bestD = d; best = id; }
        }
        return best;
    }

    private _findNearestLoot(maxRange = Infinity): number | undefined {
        let best: number | undefined, bestD = Infinity;
        const maxD = maxRange ** 2;
        for (const id of this._nearbyObjects) {
            const obj = objects.get(id);
            if (!obj || obj.type !== ObjectCategory.Loot) continue;
            const d = Geometry.distanceSquared(this.position, obj.position);
            if (d < bestD && d < maxD) { bestD = d; best = id; }
        }
        return best;
    }

    // ─────────────────────────────────────────────────────────────────────────

    /** Find the melee weapon slot (typically slot 2 = fists) */
    private _getMeleeSlot(): number {
        for (let i = 0; i < this._weapons.length; i++) {
            const id = this._weapons[i];
            if (id && WEAPON_DB.get(id)?.isMelee) return i;
        }
        return 2; // default fists slot
    }

    /** Find the best ranged weapon slot */
    private _getBestGunSlot(): number {
        let best = -1, bestDps = -1;
        for (let i = 0; i < this._weapons.length; i++) {
            const id = this._weapons[i];
            if (!id) continue;
            const p = WEAPON_DB.get(id);
            if (p && !p.isMelee && !p.isThrowable && p.dps > bestDps) {
                bestDps = p.dps;
                best = i;
            }
        }
        return best;
    }

    /**
     * Pick the best weapon in strict priority order:
     *   1. Grenade (if available, in range, off cooldown)
     *   2. Gun in slot 0 (if it has ammo and enemy is in range)
     *   3. Gun in slot 1 (fallback if slot 0 empty/no ammo)
     *   4. Melee (fists) — always works, no ammo needed
     *
     * Guns are SKIPPED if:
     *   - The bot is currently on that slot and has 0 ammo (known empty)
     *   - The enemy is too close for guns (< 3 units → fists are better)
     * Returns slot index or -1 if current slot is already best.
     */
    private _bestWeaponSlot(dist: number): number {
        if (!this._weapons.length) return -1;

        // At very close range, always use fists — guns can't aim this close
        if (dist < 3) {
            const meleeSlot = this._getMeleeSlot();
            return meleeSlot === this._slot ? -1 : meleeSlot;
        }

        // 1) GRENADE — high priority if available and in range (use often!)
        if (this._grenadeSlot !== -1 && dist > 5 && dist < 50 && this._throwableCooldown === 0) {
            return this._grenadeSlot === this._slot ? -1 : this._grenadeSlot;
        }

        // 2) Gun slot 0 — primary gun (skip if known empty)
        const gun0 = this._weapons[0];
        if (gun0 && !this._emptyGunSlots.has(0)) {
            const p0 = WEAPON_DB.get(gun0);
            if (p0 && !p0.isMelee && !p0.isThrowable && dist <= p0.range) {
                return 0 === this._slot ? -1 : 0;
            }
        }

        // 3) Gun slot 1 — secondary gun (skip if known empty)
        const gun1 = this._weapons[1];
        if (gun1 && !this._emptyGunSlots.has(1)) {
            const p1 = WEAPON_DB.get(gun1);
            if (p1 && !p1.isMelee && !p1.isThrowable && dist <= p1.range) {
                return 1 === this._slot ? -1 : 1;
            }
        }

        // 4) Melee — always works, no ammo needed
        const meleeSlot = this._getMeleeSlot();
        return meleeSlot === this._slot ? -1 : meleeSlot;
    }

    private _healAction(deepSafe: boolean): object | null {
        const missingHp  = 100 - this._health;
        const missingAdr = 100 - this._adrenaline;
        // Use medikit if safe and missing significant HP
        if (deepSafe && missingHp > 30 && (this._inventory["medikit"] ?? 0) > 0)
            return { type: InputActions.UseItem, item: MEDIKIT };
        // Use gauze aggressively — even small HP loss
        if (missingHp > 8 && (this._inventory["gauze"] ?? 0) > 0)
            return { type: InputActions.UseItem, item: GAUZE };
        // Use cola for adrenaline (provides passive regen)
        if (missingAdr > 15 && (this._inventory["cola"] ?? 0) > 0)
            return { type: InputActions.UseItem, item: COLA };
        // Use tablets for big adrenaline boost
        if (missingAdr > 35 && (this._inventory["tablets"] ?? 0) > 0)
            return { type: InputActions.UseItem, item: TABLETS };
        return null;
    }


    // ═════════════════════════════════════════════════════════════════════════
    // MAIN AI TICK
    // ═════════════════════════════════════════════════════════════════════════

    sendInputs(): void {
        if (!this._connected) return;

        this._tickCount++;
        globalTick++;
        this._moving = { up: false, down: false, left: false, right: false };

        const actions: any[] = [];
        let shouldAttack = false;
        let didDecide    = false;

        // Tick counters
        if (this._dodgeTimer       > 0) this._dodgeTimer--;
        if (this._dodgeTimer      === 0) this._takingDamage = false;
        if (this._throwableCooldown > 0) this._throwableCooldown--;

        // Track empty gun slots: if we're on a gun slot with 0 ammo for 5+ ticks, mark it empty
        const currentWeapon = this._weapons[this._slot];
        const currentProfile = currentWeapon ? WEAPON_DB.get(currentWeapon) : undefined;
        if (currentProfile && !currentProfile.isMelee && !currentProfile.isThrowable) {
            if (this._ammo === 0) {
                this._slotAmmoTicks++;
                if (this._slotAmmoTicks > 5) this._emptyGunSlots.add(this._slot);
            } else {
                this._slotAmmoTicks = 0;
                this._emptyGunSlots.delete(this._slot);  // Got ammo, not empty
            }
        } else {
            this._slotAmmoTicks = 0;
        }

        // Expire blocked enemies after 200 ticks
        for (const [eid, expiry] of this._blockedEnemyExpiry) {
            if (globalTick > expiry) {
                this._blockedEnemies.delete(eid);
                this._blockedEnemyExpiry.delete(eid);
            }
        }

        // Expire blocked crates after 300 ticks
        for (const [cid, expiry] of this._blockedCrateExpiry) {
            if (globalTick > expiry) {
                this._blockedCrates.delete(cid);
                this._blockedCrateExpiry.delete(cid);
            }
        }

        // "Activated" — once the bot gets attacked, it starts breaking crates
        if (this._takingDamage && !this._hasBeenAttacked) this._hasBeenAttacked = true;

        // ── Stuck detection (wall avoidance) ─────────────────────────────────
        const isStuck = this._updateStuck();

        // When stuck: equip melee to punch through obstacles, interact to open doors
        if (isStuck) {
            const meleeSlot = this._getMeleeSlot();
            if (this._slot !== meleeSlot && meleeSlot !== this._requestedSlot && actions.length < 8) {
                actions.push({ type: InputActions.EquipItem, slot: meleeSlot });
                this._requestedSlot = meleeSlot;
            }
            if (this._slot === this._requestedSlot) this._requestedSlot = -1;
            if (actions.length < 8) actions.push({ type: InputActions.Interact });
            shouldAttack = true;
        }

        // ── Scene queries ─────────────────────────────────────────────────────
        const mustFlee       = this._mustFleeGas();
        const fleeTarget     = this._gasFleeTarget();
        const rawEnemy       = this._findNearestEnemy();
        const crate          = this._hasBeenAttacked ? this._findNearestCrate() : undefined;
        const loot           = this._findNearestLoot(50);  // Actively seek loot within 50 units
        const hp             = this._health;
        const enemyObj       = rawEnemy !== undefined ? objects.get(rawEnemy) : undefined;
        const enemyDist      = (rawEnemy !== undefined && enemyObj)
            ? Geometry.distance(this.position, enemyObj.position) : Infinity;
        const crateObj       = crate !== undefined ? objects.get(crate) : undefined;
        const crateDist      = (crate !== undefined && crateObj)
            ? Geometry.distance(this.position, crateObj.position) : Infinity;
        const lootObj        = loot !== undefined ? objects.get(loot) : undefined;
        const lootDist       = (loot !== undefined && lootObj)
            ? Geometry.distance(this.position, lootObj.position) : Infinity;

        // ── Wall-blocked enemy detection ──────────────────────────────────────
        // If we've been stuck while chasing the same enemy for 30+ ticks, they're behind a wall
        if (rawEnemy !== undefined && isStuck) {
            if (this._lastEnemyTarget === rawEnemy) {
                this._enemyStuckTimer++;
                if (this._enemyStuckTimer > 30) {
                    this._blockedEnemies.add(rawEnemy);
                    this._blockedEnemyExpiry.set(rawEnemy, globalTick + 200);
                    this._enemyStuckTimer = 0;
                    this._lastEnemyTarget = undefined;
                }
            } else {
                this._lastEnemyTarget = rawEnemy;
                this._enemyStuckTimer = 0;
            }
        } else if (rawEnemy !== undefined) {
            this._lastEnemyTarget = rawEnemy;
            this._enemyStuckTimer = 0;
        }

        // ── Wall-blocked CRATE detection ──────────────────────────────────────
        // Same logic as enemies: if stuck chasing a crate for 30+ ticks, it's behind a wall
        if (crate !== undefined && isStuck) {
            if (this._lastCrateTarget === crate) {
                this._crateStuckTimer++;
                if (this._crateStuckTimer > 30) {
                    this._blockedCrates.add(crate);
                    this._blockedCrateExpiry.set(crate, globalTick + 300);
                    this._crateStuckTimer = 0;
                    this._lastCrateTarget = undefined;
                }
            } else {
                this._lastCrateTarget = crate;
                this._crateStuckTimer = 0;
            }
        } else if (crate !== undefined) {
            this._lastCrateTarget = crate;
            this._crateStuckTimer = 0;
        }

        // ╔══════════════════════════════════════════════════════════════════════╗
        // ║  P0  ─  GAS FLEE — ABSOLUTE OVERRIDE, NO EXCEPTIONS               ║
        // ║  When fleeing gas, bots ignore everything else and run to safety.   ║
        // ║  Also heal aggressively since they might be taking gas damage.      ║
        // ╚══════════════════════════════════════════════════════════════════════╝
        if (mustFlee && fleeTarget) {
            this._angle = Math.atan2(fleeTarget.y - this.position.y, fleeTarget.x - this.position.x);
            if (isStuck) {
                this._applyStuckEscape();
                shouldAttack = true;
                if (actions.length < 8) actions.push({ type: InputActions.Interact });
            } else {
                this._moveTowards(fleeTarget);
            }
            // Heal aggressively when fleeing gas — any HP loss matters
            const heal = this._healAction(true);
            if (heal && actions.length < 8) actions.push(heal);
            didDecide = true;
        }

        // ╔══════════════════════════════════════════════════════════════════════╗
        // ║  P1  ─  DECIDE: Attack enemy OR destroy crate (equal priority!)    ║
        // ║  Crates are treated like enemies — go for whichever is closer.      ║
        // ║  Only exception: enemies within 15 units get absolute priority.     ║
        // ╚══════════════════════════════════════════════════════════════════════╝
        const enemyIsVeryClose = rawEnemy !== undefined && enemyDist < 15;
        const preferEnemy = rawEnemy !== undefined && (enemyIsVeryClose || enemyDist <= crateDist);
        const preferCrate = !preferEnemy && crate !== undefined;

        // ── P1a: COMBAT ──────────────────────────────────────────────────────
        if (!didDecide && preferEnemy && rawEnemy !== undefined && enemyObj) {
            // FINAL dead-player check right before committing to combat
            if (enemyObj.dead || this._deadPlayers.has(rawEnemy)) {
                this._deadPlayers.add(rawEnemy);
                // fall through — don't set didDecide, let crate/loot/roam handle it
            } else {
            didDecide = true;
            this._crateFailTimer = 0;

            const rawAngle = Math.atan2(enemyObj.position.y - this.position.y, enemyObj.position.x - this.position.x);
            this._angle = rawAngle;

            // Choose weapon: GRENADES FIRST if available
            const bestSlot = this._bestWeaponSlot(enemyDist);
            const weaponSlotToUse = bestSlot !== -1 ? bestSlot : this._slot;
            const bestWeapon = this._weapons[weaponSlotToUse];
            const weaponProfile = bestWeapon ? WEAPON_DB.get(bestWeapon) : undefined;
            const isMelee = weaponProfile?.isMelee ?? true;  // Default to melee if unknown
            const isThrowable = weaponProfile?.isThrowable ?? false;
            const isGun = !isMelee && !isThrowable;

            // Only send EquipItem if we haven't already requested this slot
            // This prevents spamming EquipItem every tick which CANCELS attack animations
            if (bestSlot !== -1 && bestSlot !== this._requestedSlot && actions.length < 8) {
                actions.push({ type: InputActions.EquipItem, slot: bestSlot });
                this._requestedSlot = bestSlot;
            }
            // Reset requested slot when server confirms we're on it
            if (this._slot === this._requestedSlot) this._requestedSlot = -1;

            // Grenade cooking: hold attack for 0-6 seconds worth of ticks
            if (isThrowable && !this._isCookingGrenade && this._throwableCooldown === 0) {
                this._isCookingGrenade = true;
                this._grenadeCookTimer = Math.floor(random(0, 3) * 33); // 0-3 seconds cook time
            }

            if (this._isCookingGrenade) {
                shouldAttack = true; // Hold attack to cook
                this._grenadeCookTimer--;
                if (this._grenadeCookTimer <= 0) {
                    // Release: stop attacking for 1 tick to throw
                    shouldAttack = false;
                    this._isCookingGrenade = false;
                    this._throwableCooldown = 30;  // Short cooldown — use grenades frequently
                }
            } else {
                // Normal weapon: ALWAYS ATTACK
                shouldAttack = true;
            }

            // Movement: ALWAYS move, never stand still
            if (isStuck) {
                this._applyStuckEscape();
            } else if (isMelee) {
                // Melee/fists: close in to punching range (~5 units)
                if (enemyDist > 3.7) {
                    this._moveTowards(enemyObj.position);
                } else if (enemyDist < 2.5) {
                    this._setMoveFromAngle(rawAngle + π);
                } else {
                    // At melee range: strafe around enemy while punching
                    const strafeDir = this._alternateDir * (π / 3);
                    this._setMoveFromAngle(rawAngle + strafeDir);
                }
            } else if (isThrowable) {
                if (enemyDist > 25) {
                    this._moveTowards(enemyObj.position);
                } else if (enemyDist < 12) {
                    this._setMoveFromAngle(rawAngle + π);
                } else {
                    const strafeDir = this._alternateDir * (π / 2);
                    this._setMoveFromAngle(rawAngle + strafeDir);
                }
            } else {
                // Guns: maintain ~15-20 unit distance, strafe
                if (enemyDist > 22) {
                    this._moveTowards(enemyObj.position);
                } else if (enemyDist < 10) {
                    this._setMoveFromAngle(rawAngle + π);
                } else {
                    const strafeDir = this._alternateDir * (π / 2);
                    this._setMoveFromAngle(rawAngle + strafeDir);
                }
            }

            // Reload if needed
            if (this._hasRangedWeapon && this._ammo === 0 && actions.length < 8)
                actions.push({ type: InputActions.Reload });

            // Heal during combat if HP is low
            if (hp < 70) {
                const combatHeal = this._healAction(false);
                if (combatHeal && actions.length < 8) actions.push(combatHeal);
            }

            if (actions.length < 8) actions.push({ type: InputActions.Interact });
            if (actions.length < 8) actions.push({ type: InputActions.Loot });
            } // end else (not dead enemy)
        }

        // ── P1b: BREAK CRATES ────────────────────────────────────────────────
        if (!didDecide && preferCrate && crate !== undefined && crateObj) {
            const dist = crateDist;
            this._targetCrate = crate;
            didDecide = true;

            const rawAngle = Math.atan2(crateObj.position.y - this.position.y, crateObj.position.x - this.position.x);
            this._angle = rawAngle;

            if (dist > 3.7) {
                this._crateFailTimer++;
                const isUnderAttack = this._takingDamage;
                // Only abort crate if we're being attacked by a player
                if (isUnderAttack && rawEnemy !== undefined) {
                    this._crateFailTimer = 0;
                    didDecide = false;
                } else if (isStuck) {
                    this._applyStuckEscape();
                    shouldAttack = true; // Punch obstacles out of the way
                } else {
                    this._moveTowards(crateObj.position);
                }
                // Start attacking once within melee range even while approaching
                if (dist < 6) shouldAttack = true;
            } else {
                this._crateFailTimer = 0;
                // At crate: stand still and punch it
                shouldAttack = true;
            }

            // EQUIP MELEE to punch (only send once to avoid canceling attack)
            const meleeSlot = this._getMeleeSlot();
            if (this._slot !== meleeSlot && meleeSlot !== this._requestedSlot && actions.length < 8) {
                actions.push({ type: InputActions.EquipItem, slot: meleeSlot });
                this._requestedSlot = meleeSlot;
            }
            if (this._slot === this._requestedSlot) this._requestedSlot = -1;

            if (dist < 7) shouldAttack = true;
            if (dist < 8) {
                if (actions.length < 8) actions.push({ type: InputActions.Interact });
                if (actions.length < 8) actions.push({ type: InputActions.Loot });
            }
        }

        // ╔══════════════════════════════════════════════════════════════════════╗
        // ║  P2  ─  ACTIVE LOOT PICKUP — move toward floating ground loot      ║
        // ║  Pick up guns, ammo, healing items, scopes — anything on ground.   ║
        // ║  Priority is below combat but above idle roaming.                  ║
        // ╚══════════════════════════════════════════════════════════════════════╝
        if (!didDecide && loot !== undefined && lootObj && lootDist < 50) {
            didDecide = true;

            if (lootDist > 5) {
                // Move toward the loot
                const rawAngle = Math.atan2(lootObj.position.y - this.position.y, lootObj.position.x - this.position.x);
                this._angle = rawAngle;
                if (isStuck) {
                    this._applyStuckEscape();
                    shouldAttack = true;
                } else {
                    this._moveTowards(lootObj.position);
                }
            }
            // Always try to interact/loot when close
            if (lootDist < 12) {
                if (actions.length < 8) actions.push({ type: InputActions.Loot });
                if (actions.length < 8) actions.push({ type: InputActions.Interact });
            }
        }

        // ── Passive loot pickup (even during combat/crate breaking) ──────────
        if (loot !== undefined && lootObj && lootDist < 9) {
            if (actions.length < 8) actions.push({ type: InputActions.Loot });
            if (actions.length < 8) actions.push({ type: InputActions.Interact });
        }

        // ╔══════════════════════════════════════════════════════════════════════╗
        // ║  P3  ─  ROAM: Stay inside safe zone, explore with persistent dir   ║
        // ╚══════════════════════════════════════════════════════════════════════╝
        if (!didDecide) {
            // Determine the safe zone we should stay inside
            // Use the NEW (future) zone if gas is advancing or about to advance,
            // otherwise use the current (old) zone
            const useNewZone = this._gasState === GasState.Advancing
                || (this._gasState === GasState.Waiting && this._gasSecondsLeft <= 8);
            const safeZone = useNewZone ? this._gasNew : this._gasOld;

            if (safeZone) {
                const distToCenter = Geometry.distance(this.position, safeZone.position);
                // Stay inside 60% of the safe zone radius — gives plenty of margin
                const safeRadius = safeZone.radius * 0.60;

                if (distToCenter > safeRadius) {
                    // Outside safe roam area: move toward center
                    this._angle = Math.atan2(safeZone.position.y - this.position.y, safeZone.position.x - this.position.x);
                    if (isStuck) this._applyStuckEscape();
                    else this._moveTowards(safeZone.position);
                } else {
                    // Inside safe area: roam freely with persistent direction
                    if (globalTick > this._roamChangeTick) {
                        this._roamAngle += random(-π / 2, π / 2);
                        this._roamChangeTick = globalTick + random(30, 120);
                    }

                    // Check if roaming in this direction would take us outside the safe zone
                    // Predict position ~20 ticks ahead
                    const predictDist = 6;  // approximate distance over 20 ticks
                    const predictX = this.position.x + Math.cos(this._roamAngle) * predictDist;
                    const predictY = this.position.y + Math.sin(this._roamAngle) * predictDist;
                    const predictDistToCenter = Geometry.distance({ x: predictX, y: predictY }, safeZone.position);
                    if (predictDistToCenter > safeRadius) {
                        // Would leave safe zone — turn toward center instead
                        this._roamAngle = Math.atan2(safeZone.position.y - this.position.y, safeZone.position.x - this.position.x);
                        this._roamAngle += random(-π / 4, π / 4);  // slight randomness
                    }

                    this._angle = this._roamAngle;
                    if (isStuck) {
                        this._applyStuckEscape();
                        this._roamAngle += π / 2; // Turn when hitting wall
                    } else {
                        this._setMoveFromAngle(this._roamAngle);
                    }
                }
            } else {
                // No gas data yet: random walk with persistent direction
                if (globalTick > this._roamChangeTick) {
                    this._roamAngle += random(-π / 2, π / 2);
                    this._roamChangeTick = globalTick + random(30, 120);
                }
                if (isStuck) {
                    this._applyStuckEscape();
                    this._roamAngle += π / 2;
                } else {
                    this._setMoveFromAngle(this._roamAngle);
                }
            }
            // Try to open doors while roaming
            if (this._tickCount % 5 === 0 && actions.length < 8)
                actions.push({ type: InputActions.Interact });
            didDecide = true;
        }

        // Ensure bot is ALWAYS moving (except when breaking a crate at close range)
        if (!this._isMoving() && !(preferCrate && crateDist <= 3.7 && crateDist > 0)) {
            this._randomMovement();
        }

        // Heal whenever possible — aggressively keep HP topped up
        if (hp < 95) {
            const heal = this._healAction(!rawEnemy);  // deepSafe=true when no enemy (allows medikit)
            if (heal && actions.length < 8) actions.push(heal);
        }
        if (this._ammo === 0 && actions.length < 8) actions.push({ type: InputActions.Reload });

        // Advance or reset the attack cycle counter (used for single-fire weapon toggling)
        if (shouldAttack) {
            this._attackCycleTick++;
        } else {
            this._attackCycleTick = 0;
        }

        // ── ATTACK TOGGLING for non-auto weapons ────────────────────────────
        // The server only fires single-fire guns and default melee on the
        // rising edge (false→true transition) of the `attacking` flag.
        // We must cycle shouldAttack on/off to create repeated "click" events.
        // Auto weapons are fine with continuous `attacking: true`.
        if (shouldAttack) {
            const activeWep = this._weapons[this._slot];
            const activeProfile = activeWep ? WEAPON_DB.get(activeWep) : undefined;
            if (activeProfile && !activeProfile.isAuto) {
                // Calculate fire cycle in ticks: weapon fire delay / 30ms per bot tick
                // Minimum 3 ticks to ensure the server sees the full press→release→press cycle
                const cycleTicks = Math.max(3, Math.ceil(activeProfile.fireDelayMs / 30));
                // Release attack for 1 tick every cycle to create a new rising edge
                if (this._attackCycleTick % cycleTicks === 0) {
                    shouldAttack = false;
                }
            }
        }

        // Smooth aim — faster response when attacking
        const smoothFactor = shouldAttack ? 0.98 : 0.88;
        this._smoothedAngle = lerpAngle(this._smoothedAngle, this._angle, smoothFactor);

        const inputPacket = InputPacket.create({
            movement:        { ...this._moving },
            attacking:       shouldAttack,
            isMobile:        false,
            turning:         true,
            rotation:        this._smoothedAngle,
            distanceToMouse: this._distToMouse,
            pingSeq:         0,
            actions:         actions.slice(0, 8)
        });

        // ALWAYS send packet (removed dedup that was causing attack drops)
        try { this.sendPacket(inputPacket); this._lastInputPacket = inputPacket; }
        catch (e) { console.error(`Packet error bot ${this.id}:`, e); }
    }

    // ── Navigation (with wall-dodge support) ──────────────────────────────────

    private _moveTowards(target: Vector): void {
        const a = Math.atan2(target.y - this.position.y, target.x - this.position.x);
        this._lastMoveAngle = a; // Remember for stuck escape
        // If we've been slightly struggling to move (but not fully "stuck"),
        // try to drift to the side to go AROUND obstacles.
        const drift = this._stuckTimer > 0 ? (π / 4) * this._alternateDir : 0;
        this._setMoveFromAngle(a + drift);
    }

    /** Set movement flags from a direction angle */
    private _setMoveFromAngle(a: number): void {
        const sin = Math.sin(a);
        const cos = Math.cos(a);
        // Suroi: +Y is DOWN, -Y is UP (standard 2D game screen space)
        this._moving.up    = sin < -0.3;
        this._moving.down  = sin >  0.3;
        this._moving.left  = cos < -0.3;
        this._moving.right = cos >  0.3;
    }

    private _randomMovement(): void {
        switch (random(1, 8)) {
            case 1: this._moving.up    = true; break;
            case 2: this._moving.down  = true; break;
            case 3: this._moving.left  = true; break;
            case 4: this._moving.right = true; break;
            case 5: this._moving.up    = true;  this._moving.left  = true; break;
            case 6: this._moving.up    = true;  this._moving.right = true; break;
            case 7: this._moving.down  = true;  this._moving.left  = true; break;
            case 8: this._moving.down  = true;  this._moving.right = true; break;
        }
    }

    // ── Network ───────────────────────────────────────────────────────────────

    private _join(): void {
        this._connected = true;
        console.log(`✅ 🌍BOT_${this.id} connected to game ${this.gameID} on remote server`);
        this.sendPacket(JoinPacket.create({
            name:     pickRandomInArray(BOT_NAMES),
            isMobile: false,
            skin:     Skins.reify(pickRandomInArray(skins)),
            emotes:   []
        }));
    }

    sendPacket(packet: PacketDataIn): void {
        this._stream.stream.index = 0;
        this._stream.serialize(packet);
        this._ws.send(this._stream.getBuffer());
    }
}

// ─────────────────────────── Bot names (blend in) ────────────────────────────

const BOT_NAMES = [
    "Player", "Survivor", "pro gamer", "noob", "GG", "lol", "bruh",
    "Shadow", "Ghost", "Ninja", "Hunter", "Zombie", "Sniper", "Eagle",
    "Wolf", "Viper", "Storm", "Flash", "Blaze", "Frost", "Thunder",
    "Phoenix", "Dragon", "Titan", "Reaper", "Raven", "Cobra", "Hawk",
    "Ace", "Nova", "Spark", "Bullet", "Arrow", "Dagger", "Blade",
    "idk", "xD", "gg ez", "why", "hi", "help", "sus", "amogus",
    "bot", "real player", "not a bot", "suroi pro", "tryhard",
    "goated", "cracked", "sweat", "casual", "touch grass",
];

// ─────────────────────────── Skins ───────────────────────────────────────────

const skins: readonly ReferenceTo<SkinDefinition>[] = Skins.definitions
    .filter(({ hideFromLoadout, rolesRequired }) => !hideFromLoadout && !rolesRequired)
    .map(({ idString }) => idString);

// ─────────────────────────── Spawn ───────────────────────────────────────────

const createBot = async (id: number, retries = 3): Promise<Bot> => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const resp = await fetch(`${config.mainAddress}/api/getGame`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
            const gameData = await resp.json() as any;
            if (!gameData.success) throw new Error("API returned success=false");
            return new Bot(id, gameData.gameID);
        } catch (err) {
            console.error(`⚠️  Bot ${id} connection attempt ${attempt}/${retries} failed:`, err);
            if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
            else throw err;
        }
    }
    throw new Error("Unreachable");
};

void (async () => {
    console.log("🚀 Scheduling bot joins...");
    for (let i = 1; i <= config.botCount; i++) {
        try {
            bots.push(await createBot(i));
            if (i === config.botCount) allBotsJoined = true;
            await new Promise(resolve => setTimeout(resolve, config.joinDelay));
        } catch (err) { console.error(`Failed to create bot ${i}:`, err); }
    }
    console.log(`✅ All ${config.botCount} cracked bots spawned!`);
})();

// ─────────────────────────── Game loop ───────────────────────────────────────

console.log(`🎮 Starting cracked bot AI loop (targeting ${config.mainAddress})...`);
setInterval(async () => {
    for (let i = bots.length - 1; i >= 0; i--) {
        const bot = bots[i];
        bot.sendInputs();
        if (bot.disconnected) {
            if (config.rejoinOnDeath) bots[i] = await createBot(i + 1);
            else bots.splice(i, 1);
        }
    }
    if (bots.length === 0 && allBotsJoined) { console.log("All bots dead. Exiting."); process.exit(); }
}, 30);