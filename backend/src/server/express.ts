import express, { Request, Response, NextFunction } from "express";
import type { IncomingMessage, ServerResponse } from "http";

/**
 * Express-based HTTP Server for OpenMemory
 * 
 * Replaces the simple custom server.js implementation with Express
 * to support proper streaming, middleware, and MCP integration.
 */

export interface ServerConfig {
    max_payload_size?: number;
}

export function createExpressServer(config: ServerConfig = {}) {
    const app = express();
    
    // Set payload size limit
    const limit = config.max_payload_size || 10_000_000; // 10MB default
    
    // JSON body parser with size limit
    app.use(express.json({ limit }));
    
    // URL-encoded body parser
    app.use(express.urlencoded({ extended: true, limit }));
    
    // Add request extensions for compatibility
    app.use((req: any, res: any, next) => {
        // Add path alias for req.path (already exists in Express)
        // Add hostname parsing
        req.hostname = (req.headers.host || '').split(':')[0];
        
        // Add IP address
        req.ip = req.socket.remoteAddress || req.ip;
        
        next();
    });
    
    return app;
}

export default createExpressServer;
