#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDoctorServer } from "./server.js";

const server = createDoctorServer();
await server.connect(new StdioServerTransport());
