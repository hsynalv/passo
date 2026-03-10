const logger = require('../utils/logger');

/**
 * Proxy Pool Manager - Handles multiple proxies with rotation and failover
 */
class ProxyPool {
    constructor() {
        this.proxies = [];
        this.currentIndex = 0;
        this.blacklist = new Map(); // proxy -> { failedAt, reason }
        this.healthCheckCache = new Map(); // proxy -> { checkedAt, healthy }
        this.stats = new Map(); // proxy -> { uses, failures, lastUsed }
        this.maxRetries = 3;
        this.blacklistDurationMs = 5 * 60 * 1000; // 5 minutes
        this.healthCheckTimeoutMs = 10000;
    }

    /**
     * Initialize proxy pool from environment variable or config
     * Format: host:port:user:pass,host:port:user:pass,... (no auth: host:port::)
     * Or JSON: [{"host":"x","port":y,"username":"u","password":"p"}]
     */
    initFromEnv() {
        const proxyEnv = process.env.PROXY_LIST || process.env.PROXY_POOL || '';
        if (!proxyEnv) {
            logger.info('ProxyPool: No proxy list configured');
            return false;
        }

        try {
            // Try JSON format first
            if (proxyEnv.trim().startsWith('[') || proxyEnv.trim().startsWith('{')) {
                const parsed = JSON.parse(proxyEnv);
                if (Array.isArray(parsed)) {
                    this.proxies = parsed.map(p => this.normalizeProxy(p));
                } else {
                    this.proxies = [this.normalizeProxy(parsed)];
                }
            } else {
                // Comma-separated format: host:port:user:pass
                this.proxies = proxyEnv.split(',').map(str => {
                    const parts = str.trim().split(':');
                    if (parts.length < 2) return null;
                    
                    return {
                        host: parts[0],
                        port: parseInt(parts[1], 10),
                        username: parts[2] || null,
                        password: parts[3] || null,
                        id: `${parts[0]}:${parts[1]}`
                    };
                }).filter(Boolean);
            }

            logger.info('ProxyPool initialized', { 
                count: this.proxies.length, 
                proxies: this.proxies.map(p => p.id) 
            });
            return this.proxies.length > 0;
        } catch (e) {
            logger.error('ProxyPool init failed', { error: e.message, env: proxyEnv.substring(0, 100) });
            return false;
        }
    }

    normalizeProxy(p) {
        return {
            host: p.host || p.hostname || p.server || p.address,
            port: parseInt(p.port || p.proxyPort, 10),
            username: p.username || p.user || p.proxyUsername || null,
            password: p.password || p.pass || p.proxyPassword || null,
            id: `${p.host || p.hostname || p.server || p.address}:${p.port || p.proxyPort}`
        };
    }

    /**
     * Get next available proxy with round-robin rotation
     */
    async getNextProxy() {
        if (this.proxies.length === 0) {
            return null;
        }

        const now = Date.now();
        const candidates = [];

        // Build list of available proxies (not blacklisted)
        for (let i = 0; i < this.proxies.length; i++) {
            const idx = (this.currentIndex + i) % this.proxies.length;
            const proxy = this.proxies[idx];
            
            const blacklistEntry = this.blacklist.get(proxy.id);
            if (blacklistEntry && (now - blacklistEntry.failedAt) < this.blacklistDurationMs) {
                continue; // Still blacklisted
            } else if (blacklistEntry) {
                this.blacklist.delete(proxy.id); // Clear expired blacklist
            }

            candidates.push({ proxy, index: idx });
        }

        if (candidates.length === 0) {
            // All proxies blacklisted, force reset
            logger.warn('ProxyPool: All proxies blacklisted, clearing blacklist');
            this.blacklist.clear();
            return this.proxies[this.currentIndex % this.proxies.length];
        }

        // Try health check for first available
        for (const { proxy, index } of candidates) {
            const isHealthy = await this.healthCheck(proxy);
            if (isHealthy) {
                this.currentIndex = (index + 1) % this.proxies.length;
                this.stats.set(proxy.id, {
                    ...this.stats.get(proxy.id),
                    uses: (this.stats.get(proxy.id)?.uses || 0) + 1,
                    lastUsed: now
                });
                logger.debug('ProxyPool: Selected proxy', { proxy: proxy.id });
                return proxy;
            }
        }

        // No healthy proxy found, return first candidate anyway (last resort)
        logger.warn('ProxyPool: No healthy proxy, using first available');
        const fallback = candidates[0];
        this.currentIndex = (fallback.index + 1) % this.proxies.length;
        return fallback.proxy;
    }

    /**
     * Quick health check - can we reach passo through this proxy?
     */
    async healthCheck(proxy) {
        const cacheKey = proxy.id;
        const cached = this.healthCheckCache.get(cacheKey);
        const now = Date.now();
        
        if (cached && (now - cached.checkedAt) < 30000) { // 30 second cache
            return cached.healthy;
        }

        // Simple check: try to establish connection
        // In real implementation, you might want to do a HEAD request
        // For now, we assume proxy is healthy if not blacklisted recently
        const healthy = !this.blacklist.has(cacheKey);
        this.healthCheckCache.set(cacheKey, { checkedAt: now, healthy });
        return healthy;
    }

    /**
     * Mark proxy as failed (add to blacklist)
     */
    markFailed(proxy, reason = 'unknown') {
        if (!proxy || !proxy.id) return;
        
        this.blacklist.set(proxy.id, {
            failedAt: Date.now(),
            reason
        });
        
        this.stats.set(proxy.id, {
            ...this.stats.get(proxy.id),
            failures: (this.stats.get(proxy.id)?.failures || 0) + 1
        });
        
        logger.warn('ProxyPool: Proxy marked as failed', { proxy: proxy.id, reason });
    }

    /**
     * Mark proxy as working (remove from blacklist if present)
     */
    markSuccess(proxy) {
        if (!proxy || !proxy.id) return;
        this.blacklist.delete(proxy.id);
    }

    /**
     * Get proxy args for puppeteer launch
     */
    getProxyArgs(proxy) {
        if (!proxy) return { args: [], proxyApplied: false, proxy: null };

        const args = ['--window-size=1920,1080'];
        let proxyUrl = proxy.host;
        
        if (!/^(http|https|socks4|socks5):\/\//i.test(proxyUrl)) {
            proxyUrl = `http://${proxyUrl}`;
        }
        
        const u = new URL(proxyUrl);
        u.port = String(proxy.port);
        
        args.push(`--proxy-server=${u.protocol}//${u.hostname}:${u.port}`);

        return {
            args,
            proxyApplied: true,
            proxy,
            needsAuth: !!(proxy.username && proxy.password)
        };
    }

    /**
     * Get pool statistics
     */
    getStats() {
        return {
            total: this.proxies.length,
            blacklisted: this.blacklist.size,
            available: this.proxies.length - this.blacklist.size,
            proxies: this.proxies.map(p => ({
                id: p.id,
                blacklisted: this.blacklist.has(p.id),
                stats: this.stats.get(p.id) || { uses: 0, failures: 0 }
            }))
        };
    }
}

// Singleton instance
const proxyPool = new ProxyPool();

module.exports = { proxyPool, ProxyPool };
