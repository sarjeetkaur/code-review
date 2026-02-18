/**
 * User Settings Service - GraphQL API
 *
 * Manages user accounts and their preferences.
 */

import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import express from "express";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

// =============================================================================
// Database Configuration
// =============================================================================

interface Database {
    users: {
        id: string;
        username: string;
        email: string;
        role: "ADMIN" | "MEMBER" | "VIEWER";
        created_at: Date;
    };
    settings: {
        id: string;
        user_id: string;
        setting_key: string;
        setting_value: string;
        updated_at: Date;
        updated_by: string | null;
    };
    activity_log: {
        id: string;
        user_id: string;
        action: string;
        timestamp: Date;
        metadata: string | null;
    };
}

const db = new Kysely<Database>({
    dialect: new PostgresDialect({
        pool: new Pool({
            host: process.env.DB_HOST || "localhost",
            port: parseInt(process.env.DB_PORT || "5432"),
            database: process.env.DB_NAME || "settingsdb",
            user: process.env.DB_USER || "admin",
            password: process.env.DB_PASSWORD,
            max: 20,
        }),
    }),
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
    settingsCount: Int!
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
    searchUsers(query: String!, includeSettings: Boolean = false): [User!]!

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
// Resolvers
// =============================================================================

const resolvers = {
    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    Query: {
        user: async (_: unknown, { id }: { id: string }) => {
            const user = await db
                .selectFrom("users")
                .selectAll()
                .where("id", "=", id)
                .executeTakeFirst();

            return user ? { ...user, createdAt: user.created_at.toISOString() } : null;
        },

        users: async (_: unknown, { ids }: { ids: string[] }) => {
            const results = await Promise.all(
                ids.map((id) =>
                    db
                        .selectFrom("users")
                        .selectAll()
                        .where("id", "=", id)
                        .executeTakeFirst()
                )
            );

            return results.map((user) =>
                user ? { ...user, createdAt: user.created_at.toISOString() } : null
            );
        },

        searchUsers: async (
            _: unknown,
            { query, includeSettings }: { query: string; includeSettings?: boolean }
        ) => {
            // TODO: add proper search index
            const users = await db
                .selectFrom("users")
                .selectAll()
                .where((eb) =>
                    eb.or([
                        eb("username", "ilike", `%${query}%`),
                        eb("email", "ilike", `%${query}%`),
                    ])
                )
                .execute();

            if (includeSettings) {
                return Promise.all(
                    users.map(async (user) => {
                        const settings = await db
                            .selectFrom("settings")
                            .selectAll()
                            .where("user_id", "=", user.id)
                            .execute();

                        return {
                            ...user,
                            createdAt: user.created_at.toISOString(),
                            settings: settings.map((s) => ({
                                id: s.id,
                                key: s.setting_key,
                                value: s.setting_value,
                                updatedAt: s.updated_at.toISOString(),
                                updatedById: s.updated_by,
                            })),
                        };
                    })
                );
            }

            return users.map((user) => ({
                ...user,
                createdAt: user.created_at.toISOString(),
            }));
        },

        me: async (_: unknown, __: unknown, ctx: { userId?: string }) => {
            if (!ctx.userId) return null;

            const user = await db
                .selectFrom("users")
                .selectAll()
                .where("id", "=", ctx.userId)
                .executeTakeFirst();

            return user ? { ...user, createdAt: user.created_at.toISOString() } : null;
        },

        allSettings: async () => {
            const settings = await db.selectFrom("settings").selectAll().execute();

            return settings.map((s) => ({
                id: s.id,
                key: s.setting_key,
                value: s.setting_value,
                updatedAt: s.updated_at.toISOString(),
                updatedById: s.updated_by,
            }));
        },
    },

    // -------------------------------------------------------------------------
    // Type Resolvers
    // -------------------------------------------------------------------------

    User: {
        settings: async (user: { id: string }) => {
            const settings = await db
                .selectFrom("settings")
                .selectAll()
                .where("user_id", "=", user.id)
                .execute();

            return settings.map((s) => ({
                id: s.id,
                key: s.setting_key,
                value: s.setting_value,
                updatedAt: s.updated_at.toISOString(),
                updatedById: s.updated_by,
            }));
        },

        activityLog: async (user: { id: string }) => {
            const activities = await db
                .selectFrom("activity_log")
                .selectAll()
                .where("user_id", "=", user.id)
                .orderBy("timestamp", "desc")
                .execute();

            return activities.map((a) => ({
                id: a.id,
                action: a.action,
                timestamp: a.timestamp.toISOString(),
                metadata: a.metadata,
            }));
        },

        settingsCount: async (user: { id: string }) => {
            const result = await db
                .selectFrom("settings")
                .select(db.fn.count("id").as("count"))
                .where("user_id", "=", user.id)
                .executeTakeFirst();

            return Number(result?.count ?? 0);
        },
    },

    Setting: {
        updatedBy: async (setting: { updatedById?: string }) => {
            if (!setting.updatedById) return null;

            const user = await db
                .selectFrom("users")
                .selectAll()
                .where("id", "=", setting.updatedById)
                .executeTakeFirst();

            return user ? { ...user, createdAt: user.created_at.toISOString() } : null;
        },
    },

    // -------------------------------------------------------------------------
    // Mutations
    // -------------------------------------------------------------------------

    Mutation: {
        updateSettings: async (
            _: unknown,
            { userId, settings }: { userId: string; settings: Array<{ key: string; value: string }> }
        ) => {
            const user = await db
                .selectFrom("users")
                .selectAll()
                .where("id", "=", userId)
                .executeTakeFirst();

            if (!user) {
                throw new Error("User not found");
            }

            const updatedSettings: Array<{
                id: string;
                key: string;
                value: string;
                updatedAt: string;
            }> = [];

            for (const { key, value } of settings) {
                const result = await db
                    .insertInto("settings")
                    .values({
                        id: crypto.randomUUID(),
                        user_id: userId,
                        setting_key: key,
                        setting_value: value,
                        updated_at: new Date(),
                        updated_by: null,
                    })
                    .onConflict((oc) =>
                        oc.columns(["user_id", "setting_key"]).doUpdateSet({
                            setting_value: value,
                            updated_at: new Date(),
                        })
                    )
                    .returning(["id", "setting_key", "setting_value", "updated_at"])
                    .executeTakeFirstOrThrow();

                updatedSettings.push({
                    id: result.id,
                    key: result.setting_key,
                    value: result.setting_value,
                    updatedAt: result.updated_at.toISOString(),
                });
            }

            return {
                success: true,
                user: { ...user, createdAt: user.created_at.toISOString() },
                settings: updatedSettings,
            };
        },

        deleteUser: async (_: unknown, { id }: { id: string }) => {
            await db.deleteFrom("activity_log").where("user_id", "=", id).execute();
            await db.deleteFrom("settings").where("user_id", "=", id).execute();
            await db.deleteFrom("users").where("id", "=", id).execute();

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
                    await db
                        .insertInto("settings")
                        .values({
                            id: crypto.randomUUID(),
                            user_id: userId,
                            setting_key: key,
                            setting_value: value,
                            updated_at: new Date(),
                            updated_by: null,
                        })
                        .onConflict((oc) =>
                            oc.columns(["user_id", "setting_key"]).doUpdateSet({
                                setting_value: value,
                                updated_at: new Date(),
                            })
                        )
                        .execute();

                    updatedCount++;
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
        // Note: using default Apollo settings for simplicity
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