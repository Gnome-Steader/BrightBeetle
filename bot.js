#!/usr/bin/env bun

import { PacketType } from "./common/src/packets/packet";
import { InputActions, ObjectCategory } from "./common/src/constants";
import { Skins } from "./common/src/definitions/items/skins";
import { HealingItems } from "./common/src/definitions/items/healingItems";
import { InputPacket, areDifferent } from "./common/src/packets/inputPacket";
import { JoinPacket } from "./common/src/packets/joinPacket";
import { PacketStream } from "./common/src/packets/packetStream";
import { Geometry, π, τ } from "./common/src/utils/math";
import { pickRandomInArray } from "./common/src/utils/random";
import { Vec } from "./common/src/utils/vector";

const config = {
    mainAddress: "http://127.0.0.1:8000",
    gameAddress: "ws://127.0.0.1:<gameID>",
    offset: 8001,
    botCount: parseInt(process.argv[2] ?? "50", 10),
    joinDelay: 100,
    rejoinOnDeath: false
};

const RULES = {
    VISION_BASE: 70,
    MAX_ENGAGE_RANGE: 120,
    LOW_HEALTH: 60,
    CRITICAL_HEALTH: 30,
    RETREAT_HEALTH: 25,
    HIT_CHANCE_THRESHOLD: 0.38,
    PREDICTIVE_PROJECTILE_SPEED: 32,
    SAFE_LOOT_DELAY_MIN: 500,
    SAFE_LOOT_DELAY_MAX: 1200,
    GAS_SOON_MS: 12000,
    FIRE_COOLDOWN_MS: 180,
    RELOAD_TIME_MS: 1200,
    ACTIONS_MAX: 8
};

console.log(`Starting ${config.botCount} deterministic bots...`);

const skins = Skins.definitions
    .filter(({ hideFromLoadout, rolesRequired }) => !hideFromLoadout && !rolesRequired)
    .map(({ idString }) => idString);

const MEDIKIT = HealingItems.reify("medikit");
const GAUZE = HealingItems.reify("gauze");
const TABLETS = HealingItems.reify("tablets");

const bots = [];
const worldObjects = new Map();
let allBotsJoined = false;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const now = () => Date.now();

function getLootKey(data) {
    return (
        data?.item?.definition?.idString
        ?? data?.item?.idString
        ?? data?.definition?.idString
        ?? null
    );
}

function lootPriorityScore(lootKey) {
    if (!lootKey) return 1;
    if (/rifle|shotgun|smg|lmg|sniper|dmr|ar/i.test(lootKey)) return 100;
    if (/ammo|shell|bullet|mag/i.test(lootKey)) return 80;
    if (/armor|helmet|vest/i.test(lootKey)) return 70;
    if (/medikit|gauze|cola|tablets|vaccine/i.test(lootKey)) return 60;
    if (/grenade|frag|smoke|flash|key|c4|flare/i.test(lootKey)) return 50;
    return 20;
}

function distancePointToSegment(p, a, b) {
    const ab = Vec.sub(b, a);
    const ap = Vec.sub(p, a);
    const abLenSq = ab.x * ab.x + ab.y * ab.y;
    if (abLenSq <= 0.0001) return Geometry.distance(p, a);
    const t = clamp((ap.x * ab.x + ap.y * ab.y) / abLenSq, 0, 1);
    const proj = Vec(a.x + ab.x * t, a.y + ab.y * t);
    return Geometry.distance(p, proj);
}

class Bot {
    constructor(id, gameID) {
        this.id = id;
        this.gameID = gameID;
        this.position = Vec(0, 0);
        this._moving = { up: false, down: false, left: false, right: false };
        this._connected = false;
        this._disconnected = false;
        this._serverId = undefined;
        this._slot = 0;
        this._health = 100;
        this._lastHealth = 100;
        this._adrenaline = 0;
        this._angle = 0;
        this._distanceToMouse = 80;
        this._lastInputPacket = undefined;
        this._tick = 0;

        this._fireBlockedUntil = 0;
        this._reloadUntil = 0;
        this._healingUntil = 0;
        this._lootAllowedAt = 0;

        this._takingDamageUntil = 0;
        this._lastTargetId = undefined;
        this._lastTargetDistance = Infinity;
        this._gas = null;
        this._lastNearbyDoorCount = 0;
        this._path = [];

        this._rng = (id * 2654435761) >>> 0;
        this._stream = new PacketStream(new ArrayBuffer(1024));

        this._ws = new WebSocket(`${config.gameAddress.replace("<gameID>", (gameID + config.offset).toString())}/play`);
        this._ws.addEventListener("error", console.error);
        this._ws.addEventListener("open", () => this.join());
        this._ws.addEventListener("close", () => {
            this._connected = false;
            this._disconnected = true;
        });
        this._ws.binaryType = "arraybuffer";
        this._ws.onmessage = (event) => this.onMessage(event.data);
    }

    nextRand() {
        this._rng = (1664525 * this._rng + 1013904223) >>> 0;
        return this._rng / 4294967296;
    }

    get connected() { return this._connected; }
    get disconnected() { return this._disconnected; }

    get visionRange() {
        return RULES.VISION_BASE;
    }

    onMessage(data) {
        const stream = new PacketStream(data);
        while (true) {
            try {
                const packet = stream.deserialize();
                if (packet === undefined) break;
                this.onPacket(packet);
            } catch (error) {
                console.error(`Bot ${this.id} deserialize error:`, error);
                break;
            }
        }
    }

    onPacket(packet) {
        const updateObjectPosition = (obj, data) => {
            const pos = data?.position;
            if (!pos) return;

            const timestamp = now();
            const prev = obj.position;
            const dt = Math.max(1, timestamp - (obj.lastSeen ?? timestamp));
            obj.prevPosition = Vec(prev.x, prev.y);
            obj.position = Vec(pos.x, pos.y);
            obj.velocity = Vec((obj.position.x - obj.prevPosition.x) / dt, (obj.position.y - obj.prevPosition.y) / dt);
            obj.lastSeen = timestamp;

            if (obj.id === this._serverId) {
                this.position.x = pos.x;
                this.position.y = pos.y;
            }
        };

        switch (packet.type) {
            case PacketType.GameOver: {
                this._connected = false;
                this._disconnected = true;
                this._ws.close();
                const kills = packet.teammates?.find((teammate) => teammate.playerID === this.id)?.kills || 0;
                console.log(`Bot ${this.id} ended | Kills: ${kills} | Rank: ${packet.rank}`);
                break;
            }
            case PacketType.Update: {
                this._serverId ??= packet.playerData?.id?.id;
                this._slot = packet.playerData?.inventory?.activeWeaponIndex ?? this._slot;

                if (packet.playerData?.health !== undefined) {
                    this._lastHealth = this._health;
                    this._health = packet.playerData.health;
                    if (this._health < this._lastHealth) {
                        this._takingDamageUntil = now() + 1400;
                    }
                }

                if (packet.playerData?.adrenaline !== undefined) {
                    this._adrenaline = packet.playerData.adrenaline;
                }

                if (packet.gas) {
                    this._gas = {
                        state: packet.gas.state,
                        currentDuration: packet.gas.currentDuration,
                        oldPosition: packet.gas.oldPosition,
                        newPosition: packet.gas.newPosition,
                        oldRadius: packet.gas.oldRadius,
                        newRadius: packet.gas.newRadius
                    };
                }

                for (const { id } of packet.newPlayers ?? []) {
                    if (!worldObjects.has(id)) {
                        worldObjects.set(id, {
                            id,
                            type: ObjectCategory.Player,
                            position: Vec(0, 0),
                            prevPosition: Vec(0, 0),
                            velocity: Vec(0, 0),
                            lastSeen: now(),
                            lootKey: null
                        });
                    }
                }

                for (const { id, type, data } of packet.fullDirtyObjects ?? []) {
                    const existing = worldObjects.get(id);
                    const obj = existing ?? {
                        id,
                        type,
                        position: Vec(0, 0),
                        prevPosition: Vec(0, 0),
                        velocity: Vec(0, 0),
                        lastSeen: now(),
                        lootKey: null
                    };

                    obj.type = type;
                    if (type === ObjectCategory.Loot) obj.lootKey = getLootKey(data);
                    updateObjectPosition(obj, data);
                    worldObjects.set(id, obj);
                }

                for (const { id, data } of packet.partialDirtyObjects ?? []) {
                    const obj = worldObjects.get(id);
                    if (!obj) continue;
                    updateObjectPosition(obj, data);
                }

                for (const id of packet.deletedObjects ?? []) {
                    worldObjects.delete(id);
                }

                for (const id of packet.deletedPlayers ?? []) {
                    worldObjects.delete(id);
                    if (id === this._lastTargetId) {
                        const delay = RULES.SAFE_LOOT_DELAY_MIN + (this.id * 137 % (RULES.SAFE_LOOT_DELAY_MAX - RULES.SAFE_LOOT_DELAY_MIN));
                        this._lootAllowedAt = now() + delay;
                        this._lastTargetId = undefined;
                    }
                }

                break;
            }
        }
    }

    join() {
        this._connected = true;
        const name = `BOT_${this.id}`;
        console.log(`Connected: ${name} -> game ${this.gameID}`);
        this.sendPacket(JoinPacket.create({
            name,
            isMobile: false,
            skin: Skins.reify(pickRandomInArray(skins)),
            emotes: []
        }));
    }

    sendPacket(packet) {
        this._stream.stream.index = 0;
        this._stream.serialize(packet);
        this._ws.send(this._stream.getBuffer());
    }

    getNearby(filter) {
        const rangeSq = this.visionRange * this.visionRange;
        const result = [];
        for (const [id, obj] of worldObjects.entries()) {
            if (id === this._serverId) continue;
            if (filter && !filter(obj)) continue;
            const distSq = Geometry.distanceSquared(this.position, obj.position);
            if (distSq <= rangeSq) result.push({ obj, distSq });
        }
        return result;
    }

    hasLineOfSight(targetPos) {
        const blockers = this.getNearby((obj) => obj.type === ObjectCategory.Obstacle || obj.type === ObjectCategory.Building);
        for (const { obj } of blockers) {
            const d = distancePointToSegment(obj.position, this.position, targetPos);
            if (d < 3.0) {
                const dSelf = Geometry.distance(this.position, obj.position);
                const dTarget = Geometry.distance(targetPos, obj.position);
                if (dSelf > 1.5 && dTarget > 1.5) return false;
            }
        }
        return true;
    }

    getVisibleEnemies() {
        const enemies = this.getNearby((obj) => obj.type === ObjectCategory.Player)
            .filter(({ obj }) => this.hasLineOfSight(obj.position))
            .sort((a, b) => a.distSq - b.distSq);
        return enemies;
    }

    chooseEnemyTarget(visibleEnemies) {
        if (!visibleEnemies.length) return undefined;
        const nearest = visibleEnemies[0];
        const lowHealthBias = visibleEnemies.find(({ distSq }) => distSq < 35 * 35);
        return lowHealthBias?.obj ?? nearest.obj;
    }

    calculateHitChance(target, distance) {
        const distFactor = clamp(1 - (distance / RULES.MAX_ENGAGE_RANGE), 0, 1);
        const targetSpeed = Math.hypot(target.velocity.x, target.velocity.y) * 1000;
        const targetPenalty = clamp(targetSpeed / 18, 0, 0.4);
        const selfMovingPenalty = (this._moving.up || this._moving.down || this._moving.left || this._moving.right) ? 0.12 : 0;
        return clamp(distFactor - targetPenalty - selfMovingPenalty + 0.15, 0, 1);
    }

    predictAim(target, distance) {
        const leadTime = distance / RULES.PREDICTIVE_PROJECTILE_SPEED;
        return Vec(
            target.position.x + target.velocity.x * leadTime * 1000,
            target.position.y + target.velocity.y * leadTime * 1000
        );
    }

    isInGas() {
        if (!this._gas) return false;
        const d = Geometry.distance(this.position, this._gas.oldPosition);
        return d > this._gas.oldRadius;
    }

    gasClosingSoon() {
        if (!this._gas) return false;
        return this._gas.currentDuration <= RULES.GAS_SOON_MS;
    }

    nearestSafePosition() {
        if (!this._gas) return null;
        return this._gas.newPosition ?? this._gas.oldPosition;
    }

    nearestCover() {
        const covers = this.getNearby((obj) => obj.type === ObjectCategory.Obstacle || obj.type === ObjectCategory.Building)
            .sort((a, b) => a.distSq - b.distSq);
        return covers[0]?.obj?.position ?? null;
    }

    nearestValuableLoot(visibleEnemies) {
        if (visibleEnemies.length > 0) return undefined;
        if (this.isInGas()) return undefined;
        if (now() < this._lootAllowedAt) return undefined;

        const loots = this.getNearby((obj) => obj.type === ObjectCategory.Loot)
            .map(({ obj, distSq }) => ({
                obj,
                score: lootPriorityScore(obj.lootKey) - Math.sqrt(distSq)
            }))
            .sort((a, b) => b.score - a.score);
        return loots[0]?.obj;
    }

    nearestDoorLike() {
        return this.getNearby((obj) => obj.type === ObjectCategory.Building || obj.type === ObjectCategory.Obstacle)
            .sort((a, b) => a.distSq - b.distSq)[0]?.obj;
    }

    shouldRetreat(visibleEnemies, targetDistance) {
        const outnumbered = visibleEnemies.length >= 2;
        const reloadingAndPushed = now() < this._reloadUntil && targetDistance < 26;
        return this._health < RULES.RETREAT_HEALTH || outnumbered || reloadingAndPushed;
    }

    shouldHeal(visibleEnemies) {
        const safe = visibleEnemies.length === 0 && !this.isInGas();
        if (this._health < RULES.CRITICAL_HEALTH) return true;
        if (this._health < RULES.LOW_HEALTH && safe) return true;
        return false;
    }

    stopHealingIfNeeded(visibleEnemies, doorEvent) {
        if (now() > this._healingUntil) return false;
        if (visibleEnemies.length > 0) return true;
        if (this.gasClosingSoon() || this.isInGas()) return true;
        if (doorEvent) return true;
        return false;
    }

    planPath(goalPos) {
        return [goalPos];
    }

    moveToward(goalPos) {
        const path = this.planPath(goalPos);
        const waypoint = path[0] ?? goalPos;
        const diff = Vec.sub(waypoint, this.position);
        const angle = Math.atan2(diff.y, diff.x);
        this._moving = {
            up: Math.sin(angle) > 0.25,
            down: Math.sin(angle) < -0.25,
            left: Math.cos(angle) < -0.25,
            right: Math.cos(angle) > 0.25
        };
    }

    strafe(enemyPos) {
        const toEnemy = Math.atan2(enemyPos.y - this.position.y, enemyPos.x - this.position.x);
        const side = ((this._tick + this.id) % 40) < 20 ? 1 : -1;
        const a = toEnemy + side * Math.PI / 2;
        this._moving = {
            up: Math.sin(a) > 0.25,
            down: Math.sin(a) < -0.25,
            left: Math.cos(a) < -0.25,
            right: Math.cos(a) > 0.25
        };
    }

    retreatFrom(enemyPos) {
        const away = Vec.sub(this.position, enemyPos);
        const retreatGoal = Vec(this.position.x + away.x * 0.8, this.position.y + away.y * 0.8);
        this.moveToward(retreatGoal);
    }

    setAim(targetPos) {
        const diff = Vec.sub(targetPos, this.position);
        this._angle = Math.atan2(diff.y, diff.x);
        if (this._angle > π) this._angle -= τ;
        if (this._angle < -π) this._angle += τ;
    }

    decideAndBuildInput() {
        this._tick++;
        this._moving = { up: false, down: false, left: false, right: false };

        const actions = [];
        const visibleEnemies = this.getVisibleEnemies();
        const nearbyDoorLike = this.nearestDoorLike();
        const currentDoorCount = this.getNearby((o) => o.type === ObjectCategory.Building || o.type === ObjectCategory.Obstacle).length;
        const doorEvent = currentDoorCount > this._lastNearbyDoorCount;
        this._lastNearbyDoorCount = currentDoorCount;

        let attacking = false;

        if (this.stopHealingIfNeeded(visibleEnemies, doorEvent)) {
            this._healingUntil = 0;
        }

        // 1) Am I in gas? Escape immediately.
        if (this.isInGas()) {
            const safe = this.nearestSafePosition();
            if (safe) this.moveToward(safe);
            if (nearbyDoorLike && Geometry.distance(this.position, nearbyDoorLike.position) < 4 && actions.length < RULES.ACTIONS_MAX) {
                actions.push({ type: InputActions.Interact });
            }
            return { actions, attacking };
        }

        // 2) Is an enemy visible? Engage or retreat based on health + numbers.
        const target = this.chooseEnemyTarget(visibleEnemies);
        if (target) {
            const distance = Geometry.distance(this.position, target.position);
            const shouldRetreat = this.shouldRetreat(visibleEnemies, distance);
            const aimPoint = this.predictAim(target, distance);
            this.setAim(aimPoint);

            if (shouldRetreat) {
                this.retreatFrom(target.position);
            } else {
                this.strafe(target.position);
                if (distance > 18) this.moveToward(target.position);
            }

            const weaponReady = now() >= this._fireBlockedUntil && now() >= this._reloadUntil;
            const hitChance = this.calculateHitChance(target, distance);
            const inLoS = this.hasLineOfSight(target.position);
            attacking = inLoS && weaponReady && hitChance >= RULES.HIT_CHANCE_THRESHOLD;

            if (attacking) {
                this._fireBlockedUntil = now() + RULES.FIRE_COOLDOWN_MS;
                this._lastTargetId = target.id;
                this._lastTargetDistance = distance;
            } else if (now() >= this._reloadUntil && actions.length < RULES.ACTIONS_MAX) {
                actions.push({ type: InputActions.Reload });
                this._reloadUntil = now() + RULES.RELOAD_TIME_MS;
            }

            if (nearbyDoorLike && Geometry.distance(this.position, nearbyDoorLike.position) < 4 && actions.length < RULES.ACTIONS_MAX) {
                actions.push({ type: InputActions.Interact });
            }

            return { actions, attacking };
        }

        // 3) Is my health low? Heal if safe.
        if (this.shouldHeal(visibleEnemies)) {
            const cover = this.nearestCover();
            if (this._health < RULES.CRITICAL_HEALTH && cover) {
                this.moveToward(cover);
            }

            if (actions.length < RULES.ACTIONS_MAX) {
                const healItem = this._health < 35 ? MEDIKIT : (this._adrenaline < 40 ? TABLETS : GAUZE);
                if (healItem) {
                    actions.push({ type: InputActions.UseItem, item: healItem });
                }
                this._healingUntil = now() + 2500;
            }

            if (nearbyDoorLike && Geometry.distance(this.position, nearbyDoorLike.position) < 5 && actions.length < RULES.ACTIONS_MAX) {
                actions.push({ type: InputActions.Interact });
            }

            return { actions, attacking: false };
        }

        // 4) Is there valuable loot nearby? Loot if safe.
        const bestLoot = this.nearestValuableLoot(visibleEnemies);
        if (bestLoot) {
            const dist = Geometry.distance(this.position, bestLoot.position);
            this.moveToward(bestLoot.position);
            if (dist < 6 && actions.length < RULES.ACTIONS_MAX) {
                actions.push({ type: InputActions.Loot });
            }
            if (dist < 4 && actions.length < RULES.ACTIONS_MAX) {
                actions.push({ type: InputActions.Interact });
            }
            return { actions, attacking: false };
        }

        // 5) Is the circle closing soon? Move toward safe zone.
        if (this.gasClosingSoon()) {
            const safe = this.nearestSafePosition();
            if (safe) this.moveToward(safe);
            if (nearbyDoorLike && Geometry.distance(this.position, nearbyDoorLike.position) < 4 && actions.length < RULES.ACTIONS_MAX) {
                actions.push({ type: InputActions.Interact });
            }
            return { actions, attacking: false };
        }

        // 6) Otherwise: Patrol, explore, or reposition.
        const patrolAngle = ((this._tick + this.id * 3) % 360) * (Math.PI / 180);
        const patrolGoal = Vec(this.position.x + Math.cos(patrolAngle) * 12, this.position.y + Math.sin(patrolAngle) * 12);
        this.moveToward(patrolGoal);

        if (nearbyDoorLike && Geometry.distance(this.position, nearbyDoorLike.position) < 4 && actions.length < RULES.ACTIONS_MAX) {
            actions.push({ type: InputActions.Interact });
        }

        this._angle = patrolAngle;
        return { actions, attacking: false };
    }

    sendInputs() {
        if (!this._connected) return;

        const decision = this.decideAndBuildInput();

        const inputPacket = InputPacket.create({
            movement: { ...this._moving },
            attacking: decision.attacking,
            isMobile: false,
            turning: true,
            rotation: this._angle,
            distanceToMouse: this._distanceToMouse,
            pingSeq: 0,
            actions: decision.actions
        });

        if (!this._lastInputPacket || areDifferent(inputPacket, this._lastInputPacket)) {
            this.sendPacket(inputPacket);
            this._lastInputPacket = inputPacket;
        }
    }
}

const createBot = async (id) => {
    const gameData = await (await fetch(`${config.mainAddress}/api/getGame`)).json();
    if (!gameData.success) throw new Error("Error finding game.");
    return new Bot(id, gameData.gameID);
};

void (async () => {
    console.log("Scheduling deterministic bot joins...");
    for (let i = 1; i <= config.botCount; i++) {
        try {
            bots.push(await createBot(i));
            if (i === config.botCount) allBotsJoined = true;
            await new Promise((resolve) => setTimeout(resolve, config.joinDelay));
        } catch (error) {
            console.error(`Failed to create bot ${i}:`, error.message);
        }
    }
    console.log(`All ${config.botCount} bots spawned.`);
})();

console.log("Starting deterministic bot AI loop...");
setInterval(async () => {
    for (const bot of bots) {
        bot.sendInputs();

        if (bot.disconnected) {
            const index = bots.indexOf(bot);
            if (index === -1) continue;
            if (config.rejoinOnDeath) {
                bots[index] = await createBot(index + 1);
            } else {
                bots.splice(index, 1);
            }
        }
    }

    if (bots.length === 0 && allBotsJoined) {
        console.log("All bots died or disconnected, exiting.");
        process.exit();
    }
}, 30);
