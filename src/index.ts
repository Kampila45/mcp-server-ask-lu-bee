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
      name: "nl-to-sql",
      description: "Convert a natural language question to SQL, execute it, and return results with an explanation",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Natural language question about the data"
          }
        },
        required: ["question"]
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

// All other tool implementations removed - keeping only nl-to-sql

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

// Natural language to SQL tool
const nlToSql = server.tool(
  "nl-to-sql",
  {
    question: z.string().describe("Natural language question about the data")
  },
  async (args, _extra) => {
    try {
      const { question } = args;
      if (!question) {
        return {
          content: [{ type: "text", text: "Question parameter is required" }]
        };
      }
      
      // A simple approach to convert natural language to SQL
      // In a production environment, this would use an LLM API
      let sqlQuery = "";
      let explanation = "";
      
      // First get the list of tables to use in our response
      const tablesQuery = `SELECT TABLE_NAME 
                         FROM INFORMATION_SCHEMA.TABLES 
                         WHERE TABLE_TYPE = 'BASE TABLE'
                         ORDER BY TABLE_NAME`;
      const tablesResult = await executeSQL(tablesQuery);
      const availableTables = tablesResult.recordset.map((record: { TABLE_NAME: string }) => record.TABLE_NAME);
      
      // Simple pattern matching for common questions
      const lowercaseQuestion = question.toLowerCase();
      
      if (lowercaseQuestion.includes("all tables") || 
          lowercaseQuestion.includes("list tables") || 
          lowercaseQuestion.includes("show tables")) {
        sqlQuery = tablesQuery;
        explanation = "This query lists all tables in the database.";
      } 
      else if (lowercaseQuestion.match(/schema (?:of|for) ([\w_]+)/i) || 
               lowercaseQuestion.match(/describe ([\w_]+)/i) || 
               lowercaseQuestion.match(/columns (?:of|in|from) ([\w_]+)/i)) {
        // Extract table name from question
        const match = lowercaseQuestion.match(/schema (?:of|for) ([\w_]+)/i) || 
                     lowercaseQuestion.match(/describe ([\w_]+)/i) ||
                     lowercaseQuestion.match(/columns (?:of|in|from) ([\w_]+)/i);
        
        if (match && match[1]) {
          const tableName = match[1].trim();
          // Validate table name
          if (availableTables.map(t => t.toLowerCase()).includes(tableName.toLowerCase())) {
            const actualTableName = availableTables.find(t => t.toLowerCase() === tableName.toLowerCase());
            sqlQuery = `SELECT 
                        COLUMN_NAME, 
                        DATA_TYPE, 
                        CHARACTER_MAXIMUM_LENGTH,
                        IS_NULLABLE
                      FROM INFORMATION_SCHEMA.COLUMNS
                      WHERE TABLE_NAME = '${actualTableName}'
                      ORDER BY ORDINAL_POSITION`;
            explanation = `This query returns the schema (column definitions) for the ${actualTableName} table.`;
          } else {
            return {
              content: [{ type: "text", text: `Table '${tableName}' was not found in the database. Available tables: ${availableTables.join(', ')}` }]
            };
          }
        }
      } 
      else if (lowercaseQuestion.match(/(?:show|select|get|retrieve|find|list) .*? from ([\w_]+)/i)) {
        // Extract table name from question
        const match = lowercaseQuestion.match(/(?:show|select|get|retrieve|find|list) .*? from ([\w_]+)/i);
        
        if (match && match[1]) {
          const tableName = match[1].trim();
          // Validate table name
          if (availableTables.map(t => t.toLowerCase()).includes(tableName.toLowerCase())) {
            const actualTableName = availableTables.find(t => t.toLowerCase() === tableName.toLowerCase());
            let limit = 100;
            
            // Check if there's a limit mentioned in the question
            const limitMatch = lowercaseQuestion.match(/(?:top|first|limit) (\d+)/i);
            if (limitMatch && limitMatch[1]) {
              limit = parseInt(limitMatch[1]);
            }
            
            // Check if there's a where clause
            let whereClause = "";
            const whereMatch = lowercaseQuestion.match(/where ([^.]+)(?:\.|$)/i);
            if (whereMatch && whereMatch[1]) {
              // This is a very simplistic approach - in a real implementation
              // you'd use NLP to parse the condition properly
              const condition = whereMatch[1].trim();
              whereClause = `WHERE ${condition}`;
            }
            
            sqlQuery = `SELECT TOP ${limit} * FROM [${actualTableName}] ${whereClause}`;
            explanation = `This query returns up to ${limit} rows from the ${actualTableName} table${whereClause ? ' with the specified condition' : ''}.`;
          } else {
            return {
              content: [{ type: "text", text: `Table '${tableName}' was not found in the database. Available tables: ${availableTables.join(', ')}` }]
            };
          }
        }
      }
      else if (lowercaseQuestion.match(/count .*? from ([\w_]+)/i) || 
               lowercaseQuestion.match(/how many .*? in ([\w_]+)/i)) {
        // Extract table name from question
        const match = lowercaseQuestion.match(/count .*? from ([\w_]+)/i) || 
                     lowercaseQuestion.match(/how many .*? in ([\w_]+)/i);
        
        if (match && match[1]) {
          const tableName = match[1].trim();
          // Validate table name
          if (availableTables.map(t => t.toLowerCase()).includes(tableName.toLowerCase())) {
            const actualTableName = availableTables.find(t => t.toLowerCase() === tableName.toLowerCase());
            
            // Check if there's a where clause
            let whereClause = "";
            const whereMatch = lowercaseQuestion.match(/where ([^.]+)(?:\.|$)/i);
            if (whereMatch && whereMatch[1]) {
              const condition = whereMatch[1].trim();
              whereClause = `WHERE ${condition}`;
            }
            
            sqlQuery = `SELECT COUNT(*) AS RecordCount FROM [${actualTableName}] ${whereClause}`;
            explanation = `This query counts the number of records in the ${actualTableName} table${whereClause ? ' with the specified condition' : ''}.`;
          } else {
            return {
              content: [{ type: "text", text: `Table '${tableName}' was not found in the database. Available tables: ${availableTables.join(', ')}` }]
            };
          }
        }
      }
      else {
        // If we can't match a pattern, return a helpful message
        return {
          content: [{ 
            type: "text", 
            text: `I couldn't convert your question to SQL. Here are some example questions you can ask:\n\n` +
                  `- List all tables\n` +
                  `- Show schema of [table_name]\n` +
                  `- Get data from [table_name]\n` +
                  `- Count records in [table_name]\n\n` +
                  `Available tables: ${availableTables.join(', ')}`
          }]
        };
      }
      
      // If we got here, we have a valid SQL query
      if (sqlQuery) {
        // Execute the query
        const result = await executeSQL(sqlQuery);
        
        // Format the response
        return {
          content: [
            { type: "text", text: `Question: ${question}\n\n` },
            { type: "text", text: `SQL Query: ${sqlQuery}\n\n` },
            { type: "text", text: `Explanation: ${explanation}\n\n` },
            { type: "text", text: `Results:\n${JSON.stringify(result.recordset || result, null, 2)}` }
          ]
        };
      } else {
        return {
          content: [{ type: "text", text: "Unable to generate a SQL query for your question." }]
        };
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error processing natural language query: ${errorMessage}`
          }
        ]
      };
    }
  }
);

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  console.log(`Database connection configured for: ${sqlConfig.server}`);
});
