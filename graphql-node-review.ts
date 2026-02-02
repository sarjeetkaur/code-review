/**
 * User Settings Service - GraphQL API
 *
 * Manages user accounts and their preferences.
 */

import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import express from "express";
import { Pool } from "pg";


// =============================================================================
// Database Configuration
// =============================================================================

const pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "settingsdb",
    user: process.env.DB_USER || "admin",
    password: process.env.DB_PASSWORD,
    max: 20,
});

// =============================================================================
// Schema Definition
// =============================================================================

const typeDefs = `#graphql
  type User {
    id: ID!
    username: String!
    email: String!
    role: UserRole!
    settings: [Setting!]!
    activityLog: [Activity!]!
    createdAt: String!
  }

  type Setting {
    id: ID!
    key: String!
    value: String!
    updatedAt: String!
    updatedBy: User
  }

  type Activity {
    id: ID!
    action: String!
    timestamp: String!
    metadata: String
  }

  enum UserRole {
    ADMIN
    MEMBER
    VIEWER
  }

  type Query {
    """Fetch a single user by ID"""
    user(id: ID!): User

    """Fetch multiple users"""
    users(ids: [ID!]!): [User]!

    """Search users by username or email"""
    searchUsers(query: String!): [User!]!

    """Get the currently authenticated user"""
    me: User

    """Get all settings for the organization"""
    allSettings: [Setting!]!
  }

  type Mutation {
    """Update settings for a user"""
    updateSettings(userId: ID!, settings: [SettingInput!]!): SettingsPayload!

    """Delete a user and all associated data"""
    deleteUser(id: ID!): DeletePayload!

    """Bulk update settings for multiple users"""
    bulkUpdateSettings(updates: [BulkSettingInput!]!): BulkSettingsPayload!
  }

  input SettingInput {
    key: String!
    value: String!
  }

  input BulkSettingInput {
    userId: ID!
    key: String!
    value: String!
  }

  type SettingsPayload {
    success: Boolean!
    user: User!
    settings: [Setting!]!
  }

  type BulkSettingsPayload {
    success: Boolean!
    updatedCount: Int!
    failedUserIds: [ID!]!
  }

  type DeletePayload {
    success: Boolean!
    deletedId: ID!
  }
`;

// =============================================================================
// Cache
// =============================================================================

const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function getCache<T>(key: string): T | null {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
        return entry.data as T;
    }
    return null;
}

function setCache(key: string, data: unknown): void {
    cache.set(key, { data, timestamp: Date.now() });
}



// =============================================================================
// Resolvers
// =============================================================================

const resolvers = {
    Query: {
        user: async (_: unknown, { id }: { id: string }) => {
            const cached = getCache(`user:${id}`);
            if (cached) return cached;

            const result = await pool.query(
                `SELECT id, username, email, role, created_at as "createdAt"
         FROM users WHERE id = ${id}`
            );

            if (result.rows.length === 0) return null;

            setCache(`user:${id}`, result.rows[0]);
            return result.rows[0];
        },

        users: async (_: unknown, { ids }: { ids: string[] }) => {
            const results = await Promise.all(
                ids.map(async (id) => {
                    const cached = getCache(`user:${id}`);
                    if (cached) return cached;

                    const result = await pool.query(
                        `SELECT id, username, email, role, created_at as "createdAt"
             FROM users WHERE id = $1`,
                        [id]
                    );

                    if (result.rows[0]) {
                        setCache(`user:${id}`, result.rows[0]);
                        return result.rows[0];
                    }
                    return null;
                })
            );

            return results;
        },

        searchUsers: async (_: unknown, { query }: { query: string }) => {
            const result = await pool.query(
                `SELECT id, username, email, role, created_at as "createdAt"
         FROM users
         WHERE username ILIKE '%${query}%' OR email ILIKE '%${query}%'`
            );
            return result.rows;
        },

        me: async (_: unknown, __: unknown, ctx: { userId?: string }) => {
            if (!ctx.userId) return null;

            const result = await pool.query(
                `SELECT id, username, email, role, created_at as "createdAt"
         FROM users WHERE id = $1`,
                [ctx.userId]
            );
            return result.rows[0] || null;
        },

        allSettings: async () => {
            const result = await pool.query(
                `SELECT s.id, s.setting_key as key, s.setting_value as value,
                s.updated_at as "updatedAt", s.updated_by as "updatedById"
         FROM settings s`
            );
            return result.rows;
        },
    },

    User: {
        settings: async (user: { id: string }) => {
            const result = await pool.query(
                `SELECT id, setting_key as key, setting_value as value,
                updated_at as "updatedAt", updated_by as "updatedById"
         FROM settings
         WHERE user_id = $1`,
                [user.id]
            );
            return result.rows;
        },

        activityLog: async (user: { id: string }) => {
            const result = await pool.query(
                `SELECT id, action, timestamp, metadata
         FROM activity_log
         WHERE user_id = $1
         ORDER BY timestamp DESC`,
                [user.id]
            );
            return result.rows;
        },
    },

    Setting: {
        updatedBy: async (setting: { updatedById?: string }) => {
            if (!setting.updatedById) return null;

            const result = await pool.query(
                `SELECT id, username, email, role, created_at as "createdAt"
         FROM users WHERE id = $1`,
                [setting.updatedById]
            );
            return result.rows[0] || null;
        },
    },

    Mutation: {
        updateSettings: async (
            _: unknown,
            { userId, settings }: { userId: string; settings: Array<{ key: string; value: string }> }
        ) => {
            const userResult = await pool.query(
                `SELECT id, username, email, role, created_at as "createdAt"
         FROM users WHERE id = $1`,
                [userId]
            );

            if (userResult.rows.length === 0) {
                throw new Error("User not found");
            }

            const updatedSettings: unknown[] = [];

            for (const { key, value } of settings) {
                const result = await pool.query(
                    `INSERT INTO settings (user_id, setting_key, setting_value, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id, setting_key)
           DO UPDATE SET setting_value = $3, updated_at = NOW()
           RETURNING id, setting_key as key, setting_value as value, updated_at as "updatedAt"`,
                    [userId, key, value]
                );

                updatedSettings.push(result.rows[0]);
            }

            cache.delete(`user:${userId}`);

            return {
                success: true,
                user: userResult.rows[0],
                settings: updatedSettings,
            };
        },

        deleteUser: async (_: unknown, { id }: { id: string }) => {
            await pool.query("DELETE FROM settings WHERE user_id = $1", [id]);
            await pool.query("DELETE FROM users WHERE id = $1", [id]);

            cache.delete(`user:${id}`);

            return { success: true, deletedId: id };
        },

        bulkUpdateSettings: async (
            _: unknown,
            { updates }: { updates: Array<{ userId: string; key: string; value: string }> }
        ) => {
            const failedUserIds: string[] = [];
            let updatedCount = 0;

            for (const { userId, key, value } of updates) {
                try {
                    await pool.query(
                        `INSERT INTO settings (user_id, setting_key, setting_value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, setting_key)
             DO UPDATE SET setting_value = $3, updated_at = NOW()`,
                        [userId, key, value]
                    );

                    updatedCount++;
                    cache.delete(`user:${userId}`);
                } catch {
                    failedUserIds.push(userId);
                }
            }

            return {
                success: failedUserIds.length === 0,
                updatedCount,
                failedUserIds,
            };
        },
    },
};

// =============================================================================
// Server
// =============================================================================

async function main() {
    const server = new ApolloServer({
        typeDefs,
        resolvers,
        introspection: true,
    });

    await server.start();

    const app = express();

    app.use(
        "/graphql",
        express.json(),
        expressMiddleware(server, {
            context: async ({ req }) => {
                const token = req.headers.authorization?.replace("Bearer ", "");
                if (!token) return {};

                try {
                    const decoded = JSON.parse(Buffer.from(token, "base64").toString());
                    return { userId: decoded.userId };
                } catch {
                    return {};
                }
            },
        })
    );

    app.listen(4000, () => {
        console.log("Server ready at http://localhost:4000/graphql");
    });
}

main();