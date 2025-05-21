import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as sql from "mssql";
import * as dotenv from "dotenv";
import { z } from "zod";

// Load environment variables
dotenv.config();

// Configure SQL connection
const sqlConfig: sql.config = {
  user: "oilchangersprod",
  password: "prod@oilchangers2022",
  database: "OC_BI",
  server: "ocserverbiprod.database.windows.net",
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  options: {
    encrypt: true, // For Azure SQL
    trustServerCertificate: true // For local dev / non-production
  }
};

const server = new McpServer({
  name: "mssqlMCP",
  description: "A server that provides access to MSSQL database",
  version: "1.0.0",
  tools: [
    {
      name: "execute-query",
      description: "Execute a SQL query on the database",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "SQL query to execute"
          }
        },
        required: ["query"]
      }
    },
    {
      name: "get-tables",
      description: "Get a list of tables in the database",
      parameters: {}
    },
    {
      name: "get-table-data",
      description: "Get data from a specific table",
      parameters: {
        type: "object",
        properties: {
          tableName: {
            type: "string",
            description: "Name of the table to query"
          },
          limit: {
            type: "number",
            description: "Maximum number of rows to return"
          }
        },
        required: ["tableName"]
      }
    },
    {
      name: "get-table-schema",
      description: "Get the schema of a specific table",
      parameters: {
        type: "object",
        properties: {
          tableName: {
            type: "string",
            description: "Name of the table to get schema for"
          }
        },
        required: ["tableName"]
      }
    }
  ],
});

// Connect to SQL and execute a query
async function executeSQL(query: string): Promise<sql.IResult<any>> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(query);
    return result;
  } catch (err) {
    console.error("SQL error:", err);
    throw err;
  } finally {
    if (pool) {
      await pool.close();
    }
  }
}

// Execute query tool
const executeQuery = server.tool(
  "execute-query",
  {
    query: z.string().describe("SQL query to execute")
  },
  async (args, _extra) => {
    try {
      const { query } = args;
      if (!query) {
        return {
          content: [{ type: "text", text: "Query parameter is required" }]
        };
      }
      
      // Prevent certain dangerous operations
      const lowercaseQuery = query.toLowerCase();
      if (lowercaseQuery.includes("drop ") || 
          lowercaseQuery.includes("delete ") || 
          lowercaseQuery.includes("truncate ") ||
          lowercaseQuery.includes("alter ")) {
        return {
          content: [{ type: "text", text: "For security reasons, DROP, DELETE, TRUNCATE, and ALTER operations are not allowed" }]
        };
      }
      
      const result = await executeSQL(query);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.recordset || result, null, 2)
          }
        ]
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error executing query: ${errorMessage}`
          }
        ]
      };
    }
  }
);

// Get tables tool
const getTables = server.tool(
  "get-tables",
  {},
  async (_args, _extra) => {
    try {
      const query = `SELECT TABLE_NAME 
                    FROM INFORMATION_SCHEMA.TABLES 
                    WHERE TABLE_TYPE = 'BASE TABLE'
                    ORDER BY TABLE_NAME`;
      const result = await executeSQL(query);
      
      const tableNames = result.recordset.map((record: { TABLE_NAME: string }) => record.TABLE_NAME).join(", ");
      
      return {
        content: [
          {
            type: "text",
            text: tableNames || "No tables found"
          }
        ]
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error getting tables: ${errorMessage}`
          }
        ]
      };
    }
  }
);

// Get table data tool
const getTableData = server.tool(
  "get-table-data",
  {
    tableName: z.string().describe("Name of the table to query"),
    limit: z.number().optional().describe("Maximum number of rows to return")
  },
  async (args, _extra) => {
    try {
      const { tableName, limit = 100 } = args;
      if (!tableName) {
        return {
          content: [{ type: "text", text: "Table name parameter is required" }]
        };
      }
      
      // Validate table name to prevent SQL injection
      const tableValidationQuery = `SELECT TABLE_NAME 
                                  FROM INFORMATION_SCHEMA.TABLES 
                                  WHERE TABLE_TYPE = 'BASE TABLE' 
                                  AND TABLE_NAME = '${tableName}'`;
      const validationResult = await executeSQL(tableValidationQuery);
      
      if (validationResult.recordset.length === 0) {
        return {
          content: [{ type: "text", text: `Table '${tableName}' not found` }]
        };
      }
      
      const query = `SELECT TOP ${limit} * FROM [${tableName}]`;
      const result = await executeSQL(query);
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.recordset, null, 2)
          }
        ]
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error getting table data: ${errorMessage}`
          }
        ]
      };
    }
  }
);

// Get table schema tool
const getTableSchema = server.tool(
  "get-table-schema",
  {
    tableName: z.string().describe("Name of the table to get schema for")
  },
  async (args, _extra) => {
    try {
      const { tableName } = args;
      if (!tableName) {
        return {
          content: [{ type: "text", text: "Table name parameter is required" }]
        };
      }
      
      const query = `SELECT 
                      COLUMN_NAME, 
                      DATA_TYPE, 
                      CHARACTER_MAXIMUM_LENGTH,
                      IS_NULLABLE,
                      COLUMN_DEFAULT
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_NAME = '${tableName}'
                    ORDER BY ORDINAL_POSITION`;
      
      const result = await executeSQL(query);
      
      if (result.recordset.length === 0) {
        return {
          content: [{ type: "text", text: `Table '${tableName}' not found or has no columns` }]
        };
      }
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.recordset, null, 2)
          }
        ]
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error getting table schema: ${errorMessage}`
          }
        ]
      };
    }
  }
);

const app = express();

// to support multiple simultaneous connections we have a lookup object from
// sessionId to transport
const transports: { [sessionId: string]: SSEServerTransport } = {};

app.get("/sse", async (req: Request, res: Response) => {
  // Get the full URI from the request
  const host = req.get("host");

  const fullUri = `https://${host}/mssql`;
  const transport = new SSEServerTransport(fullUri, res);

  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

app.post("/mssql", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

app.get("/", (_req: Request, res: Response) => {
  res.send("MSSQL MCP Server is running!");
});

// Get the port from environment variable for Azure or use default
const PORT = process.env.PORT || process.env.WEBSITES_PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  console.log(`Database connection configured for: ${sqlConfig.server}`);
});
