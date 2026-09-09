const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        game: "rolet",
        rooms: rooms.size
    });
});

const wss = new WebSocket.Server({ server });

/*
==================================================
ROOM SYSTEM
==================================================
*/

const rooms = new Map();

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {
        code = "";

        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }

    } while (rooms.has(code));

    return code;
}

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(room, data) {
    if (!room) return;

    for (const player of room.players) {
        send(player.ws, data);
    }
}

function getPublicPlayers(room) {
    return room.players.map(player => ({
        id: player.id,
        name: player.name,
        alive: player.alive,
        isHost: player.id === room.hostId
    }));
}

/*
==================================================
GAME STATE
==================================================
*/

function createRoom() {

    const code = generateRoomCode();

    const room = {
        code,

        players: [],

        hostId: null,

        started: false,

        currentPlayerId: null,

        bullets: 0,

        remainingBullets: 0,

        round: 0,

        winner: null
    };

    rooms.set(code, room);

    return room;
}

function alivePlayers(room) {
    return room.players.filter(player => player.alive);
}

function calculateBullets(room) {

    const count = room.players.length;

    return Math.max(1, Math.floor(count / 2));
}

function chooseRandomPlayer(room) {

    const alive = alivePlayers(room);

    if (alive.length === 0) {
        room.currentPlayerId = null;
        return;
    }

    const randomIndex = Math.floor(Math.random() * alive.length);

    room.currentPlayerId = alive[randomIndex].id;
}

function getCurrentPlayer(room) {

    return room.players.find(
        player => player.id === room.currentPlayerId
    );
}

function sendRoomState(room) {

    broadcast(room, {
        type: "roomState",

        room: {
            code: room.code,

            started: room.started,

            round: room.round,

            bullets: room.bullets,

            remainingBullets: room.remainingBullets,

            currentPlayerId: room.currentPlayerId,

            hostId: room.hostId,

            winner: room.winner,

            players: getPublicPlayers(room)
        }
    });
}

/*
==================================================
START GAME
==================================================
*/

function startGame(room) {

    if (room.players.length < 2) {
        return false;
    }

    room.started = true;

    room.round = 1;

    room.winner = null;

    room.bullets = calculateBullets(room);

    room.remainingBullets = room.bullets;

    for (const player of room.players) {
        player.alive = true;
    }

    chooseRandomPlayer(room);

    sendRoomState(room);

    broadcast(room, {
        type: "gameStarted"
    });

    return true;
}

/*
==================================================
NEXT TURN
==================================================
*/

function nextTurn(room) {

    const alive = alivePlayers(room);

    if (alive.length <= 1) {

        finishGame(room);

        return;
    }

    chooseRandomPlayer(room);

    room.round++;

    sendRoomState(room);
}

/*
==================================================
SHOOT
==================================================
*/

function shoot(room, shooterId, targetId) {

    if (!room.started) {
        return {
            success: false,
            error: "GAME_NOT_STARTED"
        };
    }

    if (room.currentPlayerId !== shooterId) {
        return {
            success: false,
            error: "NOT_YOUR_TURN"
        };
    }

    const shooter = room.players.find(
        player => player.id === shooterId
    );

    const target = room.players.find(
        player => player.id === targetId
    );

    if (!shooter || !target) {
        return {
            success: false,
            error: "PLAYER_NOT_FOUND"
        };
    }

    if (!shooter.alive || !target.alive) {
        return {
            success: false,
            error: "PLAYER_DEAD"
        };
    }

    if (room.remainingBullets <= 0) {
        return {
            success: false,
            error: "NO_BULLETS"
        };
    }

    /*
    در این نسخه اگر تیر موجود باشد،
    شلیک باعث حذف هدف می‌شود.
    */

    room.remainingBullets--;

    target.alive = false;

    broadcast(room, {
        type: "shot",

        shooterId,

        targetId,

        targetAlive: false,

        remainingBullets: room.remainingBullets
    });

    const alive = alivePlayers(room);

    /*
    اگر فقط یک نفر زنده مانده باشد
    بازی تمام می‌شود.
    */

    if (alive.length <= 1) {

        finishGame(room);

        return {
            success: true
        };
    }

    /*
    اگر گلوله‌های این راند تمام شده،
    راند جدید شروع می‌شود.
    */

    if (room.remainingBullets <= 0) {

        room.round++;

        room.remainingBullets = room.bullets;

        chooseRandomPlayer(room);

        broadcast(room, {
            type: "newRound",

            round: room.round,

            bullets: room.bullets,

            remainingBullets: room.remainingBullets,

            currentPlayerId: room.currentPlayerId
        });

    } else {

        /*
        بازیکن بعدی
        */

        chooseRandomPlayer(room);

        broadcast(room, {
            type: "nextTurn",

            currentPlayerId: room.currentPlayerId,

            remainingBullets: room.remainingBullets
        });
    }

    sendRoomState(room);

    return {
        success: true
    };
}

/*
==================================================
FINISH GAME
==================================================
*/

function finishGame(room) {

    const alive = alivePlayers(room);

    room.started = false;

    room.winner = alive.length === 1
        ? alive[0].id
        : null;

    room.currentPlayerId = null;

    sendRoomState(room);

    broadcast(room, {
        type: "gameOver",

        winner: room.winner
            ? alive[0].name
            : null
    });

    /*
    بعد از 10 ثانیه اتاق به حالت لابی برمی‌گردد.
    */

    setTimeout(() => {

        if (!rooms.has(room.code)) {
            return;
        }

        room.started = false;

        room.winner = null;

        room.round = 0;

        room.currentPlayerId = null;

        room.bullets = 0;

        room.remainingBullets = 0;

        for (const player of room.players) {
            player.alive = true;
        }

        sendRoomState(room);

        broadcast(room, {
            type: "returnToLobby"
        });

    }, 10000);
}

/*
==================================================
PLAYER ID
==================================================
*/

function generatePlayerId() {

    return (
        Date.now().toString(36) +
        Math.random().toString(36).substring(2, 8)
    );
}

/*
==================================================
WEBSOCKET
==================================================
*/

wss.on("connection", (ws) => {

    let player = null;

    let room = null;

    console.log("New WebSocket connection");

    send(ws, {
        type: "connected"
    });

    ws.on("message", (raw) => {

        let message;

        try {

            message = JSON.parse(raw.toString());

        } catch {

            send(ws, {
                type: "error",
                error: "INVALID_JSON"
            });

            return;
        }

        /*
        ==============================================
        CREATE ROOM
        ==============================================
        */

        if (message.type === "createRoom") {

            const name = String(message.name || "").trim();

            if (!name) {

                send(ws, {
                    type: "error",
                    error: "NAME_REQUIRED"
                });

                return;
            }

            if (room) {

                send(ws, {
                    type: "error",
                    error: "ALREADY_IN_ROOM"
                });

                return;
            }

            room = createRoom();

            player = {
                id: generatePlayerId(),

                name: name.substring(0, 20),

                alive: true,

                ws
            };

            room.players.push(player);

            room.hostId = player.id;

            send(ws, {
                type: "roomCreated",

                roomCode: room.code,

                playerId: player.id
            });

            sendRoomState(room);

            return;
        }

        /*
        ==============================================
        JOIN ROOM
        ==============================================
        */

        if (message.type === "joinRoom") {

            const name = String(message.name || "").trim();

            const code = String(message.code || "")
                .trim()
                .toUpperCase();

            if (!name) {

                send(ws, {
                    type: "error",
                    error: "NAME_REQUIRED"
                });

                return;
            }

            if (!code) {

                send(ws, {
                    type: "error",
                    error: "ROOM_CODE_REQUIRED"
                });

                return;
            }

            room = rooms.get(code);

            if (!room) {

                send(ws, {
                    type: "error",
                    error: "ROOM_NOT_FOUND"
                });

                return;
            }

            if (room.started) {

                send(ws, {
                    type: "error",
                    error: "GAME_ALREADY_STARTED"
                });

                return;
            }

            if (room.players.length >= 12) {

                send(ws, {
                    type: "error",
                    error: "ROOM_FULL"
                });

                return;
            }

            player = {

                id: generatePlayerId(),

                name: name.substring(0, 20),

                alive: true,

                ws
            };

            room.players.push(player);

            send(ws, {

                type: "roomJoined",

                roomCode: room.code,

                playerId: player.id
            });

            sendRoomState(room);

            return;
        }

        /*
        ==============================================
        START GAME
        ==============================================
        */

        if (message.type === "startGame") {

            if (!room || !player) {
                return;
            }

            if (player.id !== room.hostId) {

                send(ws, {
                    type: "error",
                    error: "ONLY_HOST_CAN_START"
                });

                return;
            }

            if (room.players.length < 2) {

                send(ws, {
                    type: "error",
                    error: "NOT_ENOUGH_PLAYERS"
                });

                return;
            }

            startGame(room);

            return;
        }

        /*
        ==============================================
        SHOOT
        ==============================================
        */

        if (message.type === "shoot") {

            if (!room || !player) {
                return;
            }

            const targetId = String(
                message.targetId || ""
            );

            const result = shoot(
                room,
                player.id,
                targetId
            );

            if (!result.success) {

                send(ws, {
                    type: "error",
                    error: result.error
                });
            }

            return;
        }

        /*
        ==============================================
        PING
        ==============================================
        */

        if (message.type === "ping") {

            send(ws, {
                type: "pong"
            });

            return;
        }

    });

    /*
    ==============================================
    DISCONNECT
    ==============================================
    */

    ws.on("close", () => {

        console.log("WebSocket disconnected");

        if (!room || !player) {
            return;
        }

        const index = room.players.findIndex(
            p => p.id === player.id
        );

        if (index !== -1) {
            room.players.splice(index, 1);
        }

        /*
        اگر میزبان خارج شد،
        بازیکن دیگری میزبان می‌شود.
        */

        if (room.hostId === player.id) {

            if (room.players.length > 0) {

                room.hostId = room.players[0].id;

            } else {

                rooms.delete(room.code);

                return;
            }
        }

        /*
        اگر بازی در حال انجام بوده
        و بازیکن خارج شد،
        وضعیت بازی دوباره بررسی می‌شود.
        */

        if (room.started) {

            const alive = alivePlayers(room);

            if (alive.length <= 1) {

                finishGame(room);

                return;
            }

            if (room.currentPlayerId === player.id) {

                chooseRandomPlayer(room);
            }
        }

        sendRoomState(room);
    });

});

/*
==================================================
SERVER
==================================================
*/

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        `ROLET server running on port ${PORT}`
    );

});
