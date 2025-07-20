const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const MultiplayerServer = require('./multiplayerServer');

const app = express();
app.use(cors());
app.use(express.json());

// Rota de health check
app.get('/healthz', (req, res) => {
    const healthStatus = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        version: '1.0.0',
        service: 'multiplayer-game-server',
        players: {
            connected: 0,
            total_sessions: 0
        },
        game: {
            tick_rate: 60,
            bullets_active: 0,
            server_tick: 0
        },
        system: {
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
                unit: 'MB'
            },
            cpu_usage: process.cpuUsage(),
            node_version: process.version
        }
    };

    // Atualizar dados se o servidor multiplayer estiver inicializado
    if (global.multiplayerServerInstance) {
        healthStatus.players.connected = global.multiplayerServerInstance.players.size;
        healthStatus.players.total_sessions = global.multiplayerServerInstance.players.size;
        healthStatus.game.bullets_active = global.multiplayerServerInstance.bullets.size;
        healthStatus.game.server_tick = global.multiplayerServerInstance.gameState.tick;
    }

    res.status(200).json(healthStatus);
});

// Rota de métricas detalhadas
app.get('/metrics', (req, res) => {
    const metrics = {
        timestamp: new Date().toISOString(),
        server: {
            uptime_seconds: process.uptime(),
            memory_usage: process.memoryUsage(),
            cpu_usage: process.cpuUsage(),
            node_version: process.version,
            platform: process.platform,
            arch: process.arch
        },
        game: {
            active_players: 0,
            active_bullets: 0,
            server_tick: 0,
            tick_rate: 60,
            update_rate: 20
        },
        players_detail: [],
        performance: {
            memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            memory_peak_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            gc_stats: process.memoryUsage()
        }
    };

    // Dados detalhados do jogo
    if (global.multiplayerServerInstance) {
        const server = global.multiplayerServerInstance;
        metrics.game.active_players = server.players.size;
        metrics.game.active_bullets = server.bullets.size;
        metrics.game.server_tick = server.gameState.tick;

        // Dados dos jogadores (sem informações sensíveis)
        metrics.players_detail = Array.from(server.players.values()).map(player => ({
            id: player.id.substring(0, 8),
            name: player.name,
            health: player.health,
            kills: player.kills,
            deaths: player.deaths,
            ammo: player.ammo,
            connected_for: Math.floor((Date.now() - (Date.now() - (Date.now() - player.lastUpdate))) / 1000)
        }));
    }

    res.status(200).json(metrics);
});

// Rota de status simples (para load balancers)
app.get('/status', (req, res) => {
    res.status(200).send('OK');
});

// Rota básica de informações
app.get('/', (req, res) => {
    res.json({
        message: 'Multiplayer Game Server is running!',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor(process.uptime()),
        endpoints: {
            health: '/healthz',
            metrics: '/metrics',
            status: '/status',
            websocket: 'ws://localhost:3001'
        },
        stats: global.multiplayerServerInstance ? {
            players: global.multiplayerServerInstance.players.size,
            bullets: global.multiplayerServerInstance.bullets.size,
            tick: global.multiplayerServerInstance.gameState.tick
        } : {
            players: 0,
            bullets: 0,
            tick: 0
        }
    });
});

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "https://jogo-teste-ia.onrender.com/",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;

// Inicializar servidor
const multiplayerServer = new MultiplayerServer(io);
global.multiplayerServerInstance = multiplayerServer; // Tornar acessível para as rotas

server.listen(PORT, () => {
    console.log(`🚀 Servidor Multiplayer rodando na porta ${PORT}`);
    console.log(`🎮 Aguardando jogadores...`);
    console.log(`📊 Health check disponível em: http://localhost:${PORT}/healthz`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Desligando servidor...');
    server.close(() => {
        console.log('✅ Servidor desligado com sucesso');
        process.exit(0);
    });
});
