import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to apply database migrations.");
const connection = await mysql.createConnection(process.env.DATABASE_URL);
try {
  await migrate(drizzle(connection), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  console.log("Database migrations completed.");
} finally { await connection.end(); }
