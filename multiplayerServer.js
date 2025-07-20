class MultiplayerServer {
    constructor(io) {
        this.players = new Map();
        this.bullets = new Map();
        this.gameState = {
            tick: 0,
            lastUpdate: Date.now()
        };

        // Configurações de otimização
        this.TICK_RATE = 60; // 60 FPS do servidor
        this.CLIENT_UPDATE_RATE = 20; // 20 atualizações por segundo para clientes
        this.BULLET_CLEANUP_INTERVAL = 5000; // 5 segundos
        this.MAX_BULLETS = 500;

        this.io = io;

        this.setupSocketHandlers();
        this.startGameLoop();
        this.startCleanupLoop();
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`Jogador conectado: ${socket.id}`);

            // Inicializar jogador
            this.initializePlayer(socket);

            // Handlers dos eventos
            socket.on('player-update', (data) => this.handlePlayerUpdate(socket, data));
            socket.on('player-fire', (data) => this.handlePlayerFire(socket, data));
            socket.on('player-reload', () => this.handlePlayerReload(socket));
            socket.on('disconnect', () => this.handleDisconnect(socket));
        });
    }

    initializePlayer(socket) {
        const player = {
            id: socket.id,
            position: { x: 0, y: 1.8, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            velocity: { x: 0, z: 0 },
            health: 100,
            maxHealth: 100,
            ammo: 30,
            totalAmmo: 120,
            isReloading: false,
            lastUpdate: Date.now(),
            name: `Player_${socket.id.substring(0, 6)}`,
            kills: 0,
            deaths: 0,
            connected: true
        };

        this.players.set(socket.id, player);

        // Enviar estado inicial para o novo jogador
        socket.emit('game-init', {
            playerId: socket.id,
            players: Array.from(this.players.values()),
            gameState: this.gameState
        });

        // Notificar outros jogadores sobre o novo jogador
        socket.broadcast.emit('player-joined', player);

        console.log(`Jogador ${player.name} entrou no jogo. Total: ${this.players.size}`);
    }

    handlePlayerUpdate(socket, data) {
        const player = this.players.get(socket.id);
        if (!player) return;

        // Validação básica dos dados
        if (!this.isValidPosition(data.position)) return;

        // Anti-cheat: limitar velocidade máxima
        const maxSpeed = 0.5;
        if (data.velocity) {
            const speed = Math.sqrt(data.velocity.x ** 2 + data.velocity.z ** 2);
            if (speed > maxSpeed) {
                // Normalizar velocidade
                const factor = maxSpeed / speed;
                data.velocity.x *= factor;
                data.velocity.z *= factor;
            }
        }

        // Atualizar dados do jogador
        player.position = data.position;
        player.rotation = data.rotation;
        player.velocity = data.velocity || { x: 0, z: 0 };
        player.lastUpdate = Date.now();

        // Interpolação suave será feita no cliente
    }

    handlePlayerFire(socket, data) {
        const player = this.players.get(socket.id);
        if (!player || player.health <= 0 || player.isReloading || player.ammo <= 0) return;

        // Rate limiting - máximo 10 tiros por segundo
        const now = Date.now();
        if (!player.lastFireTime) player.lastFireTime = 0;
        if (now - player.lastFireTime < 100) return; // 100ms entre tiros

        player.lastFireTime = now;
        player.ammo--;

        // Auto reload
        if (player.ammo <= 0 && player.totalAmmo > 0) {
            this.startReload(player);
        }

        // Criar bala
        const bulletId = `${socket.id}_${Date.now()}_${Math.random()}`;
        const bullet = {
            id: bulletId,
            playerId: socket.id,
            position: { ...data.position },
            direction: { ...data.direction },
            speed: 50,
            damage: 25,
            createdAt: now,
            lifetime: 3000
        };

        this.bullets.set(bulletId, bullet);

        // Limitar número de balas
        if (this.bullets.size > this.MAX_BULLETS) {
            const oldestBullet = Array.from(this.bullets.entries())
                .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
            this.bullets.delete(oldestBullet[0]);
        }

        // Notificar todos os jogadores sobre o disparo
        this.io.emit('player-fired', {
            playerId: socket.id,
            bulletId: bulletId,
            position: bullet.position,
            direction: bullet.direction,
            ammo: player.ammo
        });
    }

    handlePlayerReload(socket) {
        const player = this.players.get(socket.id);
        if (!player || player.isReloading || player.totalAmmo <= 0 || player.ammo >= 30) return;

        this.startReload(player);
    }

    startReload(player) {
        player.isReloading = true;

        setTimeout(() => {
            const ammoNeeded = 30 - player.ammo;
            const ammoToReload = Math.min(ammoNeeded, player.totalAmmo);

            player.ammo += ammoToReload;
            player.totalAmmo -= ammoToReload;
            player.isReloading = false;

            // Notificar jogador sobre recarga completa
            this.io.to(player.id).emit('reload-complete', {
                ammo: player.ammo,
                totalAmmo: player.totalAmmo
            });
        }, 2000);
    }

    handleDisconnect(socket) {
        const player = this.players.get(socket.id);
        if (player) {
            console.log(`Jogador ${player.name} desconectou. Restam: ${this.players.size - 1}`);

            // Remover balas do jogador
            for (const [bulletId, bullet] of this.bullets.entries()) {
                if (bullet.playerId === socket.id) {
                    this.bullets.delete(bulletId);
                }
            }

            this.players.delete(socket.id);

            // Notificar outros jogadores
            socket.broadcast.emit('player-left', { playerId: socket.id });
        }
    }

    startGameLoop() {
        setInterval(() => {
            this.updateGameState();
        }, 1000 / this.TICK_RATE);

        // Enviar atualizações para clientes em taxa menor
        setInterval(() => {
            this.sendClientUpdates();
        }, 1000 / this.CLIENT_UPDATE_RATE);
    }

    updateGameState() {
        const now = Date.now();
        this.gameState.tick++;
        this.gameState.lastUpdate = now;

        // Atualizar balas
        this.updateBullets(now);

        // Verificar colisões
        this.checkBulletCollisions();

        // Remover jogadores inativos (30 segundos sem update)
        this.cleanupInactivePlayers(now);
    }

    updateBullets(now) {
        const deltaTime = 0.016; // ~60fps

        for (const [bulletId, bullet] of this.bullets.entries()) {
            // Mover bala
            bullet.position.x += bullet.direction.x * bullet.speed * deltaTime;
            bullet.position.y += bullet.direction.y * bullet.speed * deltaTime;
            bullet.position.z += bullet.direction.z * bullet.speed * deltaTime;

            // Remover balas expiradas
            if (now - bullet.createdAt > bullet.lifetime) {
                this.bullets.delete(bulletId);
                this.io.emit('bullet-expired', { bulletId });
            }
        }
    }

    checkBulletCollisions() {
        for (const [bulletId, bullet] of this.bullets.entries()) {
            for (const [playerId, player] of this.players.entries()) {
                // Não verificar colisão com o próprio atirador
                if (bullet.playerId === playerId || player.health <= 0) continue;

                // Verificar distância simples (pode ser otimizado com spatial partitioning)
                const distance = Math.sqrt(
                    (bullet.position.x - player.position.x) ** 2 +
                    (bullet.position.y - player.position.y) ** 2 +
                    (bullet.position.z - player.position.z) ** 2
                );

                if (distance < 0.8) { // Raio de hit do jogador
                    // Hit!
                    this.handlePlayerHit(bullet, player);
                    this.bullets.delete(bulletId);
                    break;
                }
            }
        }
    }

    handlePlayerHit(bullet, hitPlayer) {
        const shooter = this.players.get(bullet.playerId);
        if (!shooter) return;

        hitPlayer.health -= bullet.damage;

        // Notificar sobre o hit
        this.io.emit('player-hit', {
            hitPlayerId: hitPlayer.id,
            shooterId: shooter.id,
            damage: bullet.damage,
            newHealth: hitPlayer.health,
            bulletId: bullet.id
        });

        // Verificar se morreu
        if (hitPlayer.health <= 0) {
            hitPlayer.deaths++;
            shooter.kills++;

            // Notificar sobre a morte
            this.io.emit('player-killed', {
                killedPlayerId: hitPlayer.id,
                killerId: shooter.id,
                killerName: shooter.name,
                victimName: hitPlayer.name
            });

            // Respawn após 3 segundos
            setTimeout(() => {
                this.respawnPlayer(hitPlayer);
            }, 3000);
        }
    }

    respawnPlayer(player) {
        player.health = player.maxHealth;
        player.ammo = 30;
        player.totalAmmo = 120;
        player.isReloading = false;

        // Posição de respawn aleatória
        player.position = {
            x: (Math.random() - 0.5) * 50,
            y: 1.8,
            z: (Math.random() - 0.5) * 50
        };

        this.io.emit('player-respawned', {
            playerId: player.id,
            position: player.position,
            health: player.health
        });
    }

    sendClientUpdates() {
        if (this.players.size === 0) return;

        const playersData = Array.from(this.players.values()).map(player => ({
            id: player.id,
            position: player.position,
            rotation: player.rotation,
            velocity: player.velocity,
            health: player.health,
            maxHealth: player.maxHealth,
            name: player.name,
            kills: player.kills,
            deaths: player.deaths
        }));

        const bulletsData = Array.from(this.bullets.values()).map(bullet => ({
            id: bullet.id,
            position: bullet.position,
            direction: bullet.direction
        }));

        // Enviar dados otimizados
        this.io.emit('game-update', {
            players: playersData,
            bullets: bulletsData,
            tick: this.gameState.tick
        });
    }

    cleanupInactivePlayers(now) {
        for (const [playerId, player] of this.players.entries()) {
            if (now - player.lastUpdate > 60000) { // 60 segundos
                console.log(`Removendo jogador inativo: ${player.name}`);
                this.players.delete(playerId);
                this.io.emit('player-left', { playerId });
            }
        }
    }

    startCleanupLoop() {
        setInterval(() => {
            const now = Date.now();

            // Limpeza de balas antigas
            for (const [bulletId, bullet] of this.bullets.entries()) {
                if (now - bullet.createdAt > bullet.lifetime) {
                    this.bullets.delete(bulletId);
                }
            }

            console.log(`Status: ${this.players.size} jogadores, ${this.bullets.size} balas`);
        }, this.BULLET_CLEANUP_INTERVAL);
    }

    isValidPosition(position) {
        if (!position || typeof position.x !== 'number' || typeof position.z !== 'number') return false;
        if (Math.abs(position.x) > 1000 || Math.abs(position.z) > 1000) return false; // Limites do mapa
        return true;
    }
}

module.exports = MultiplayerServer;