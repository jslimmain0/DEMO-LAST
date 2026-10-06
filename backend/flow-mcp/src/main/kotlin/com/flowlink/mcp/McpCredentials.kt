package com.flowlink.mcp

/** The central host owns credentials; this module never signs tokens or owns its database. */
interface McpCredentials {
    /** Verify an MCP-only token and return a short-lived, internal management authorization. */
    fun managementAuthorization(authorization: String?): String
    fun issueForOAuth(appToken: String, clientId: String): String
}
