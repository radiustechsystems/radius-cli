// Generated from specs/swap.openapi.json by scripts/generate-api.mjs (openapi-typescript). Do not edit.
// Radius Swap API 1.0.0
export type paths = {
    "/api/v1/swap/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Prepare a swap transaction
         * @description Verifies a signed swap intent, preflights the source wallet, stores a short-lived prepared transaction in KV, and returns a complete unsigned transfer transaction the client must sign exactly as returned.
         *
         *     Example viem payload to sign before calling this endpoint:
         *
         *     ```ts
         *     const signature = await walletClient.signTypedData({
         *       account,
         *       domain: {
         *         name: 'Radius Swap API',
         *         version: '1',
         *         chainId: 84532,
         *       },
         *       types: {
         *         SwapIntent: [
         *           { name: 'sourceAddress', type: 'address' },
         *           { name: 'sourceChain', type: 'string' },
         *           { name: 'sourceToken', type: 'string' },
         *           { name: 'destinationChain', type: 'string' },
         *           { name: 'destinationToken', type: 'string' },
         *           { name: 'destinationAddress', type: 'address' },
         *           { name: 'amount', type: 'string' },
         *           { name: 'idempotencyKey', type: 'string' },
         *           { name: 'expiresAt', type: 'uint256' },
         *           { name: 'environment', type: 'string' },
         *         ],
         *       },
         *       primaryType: 'SwapIntent',
         *       message: {
         *         sourceAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
         *         sourceChain: 'base_sepolia',
         *         sourceToken: 'SBC',
         *         destinationChain: 'radius_testnet',
         *         destinationToken: 'SBC',
         *         destinationAddress: '0x2222222222222222222222222222222222222222',
         *         amount: '100.00',
         *         idempotencyKey: 'idem_01jv6e7av4pmk8m5ebj0x7xf82',
         *         expiresAt: 1786233600n,
         *         environment: 'testnet',
         *       },
         *     });
         *     ```
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["PrepareSwapIntentRequest"];
                };
            };
            responses: {
                /** @description Prepared transaction, scoped swap token, and unsigned transaction returned. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PrepareSwapIntentResponse"];
                    };
                };
                /** @description Missing or malformed request field. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Missing, invalid, expired, or wrong-scope swap token. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description The agent address is blocked or forbidden for this swap. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Requested swap state was not found. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description The idempotency key has already been used or an active prepared transaction already exists. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Too many prepare requests from this address. */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Unexpected internal failure. */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/swap/broadcast": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Broadcast a prepared swap and create the durable session
         * @description Validates and broadcasts the exact signed transaction referenced by the prepared swap token, creates the durable swap session, and starts the workflow.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["BroadcastSwapTransactionRequest"];
                };
            };
            responses: {
                /** @description Signed transaction accepted, session created, and workflow started. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BroadcastSwapTransactionResponse"];
                    };
                };
                /** @description Signed transaction is malformed, invalid, or does not match the prepared transaction. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Missing, invalid, expired, or wrong-scope swap token. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Swap token is valid but not scoped to this swap. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description No active prepared transaction exists for the swap token. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Prepared transaction has expired or has already been consumed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Too many requests. */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Unexpected internal failure. */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/swap/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get prepared or durable swap status
         * @description Returns the prepared swap referenced by a prepared swap token, or the durable session referenced by a session status token.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Current prepared or durable swap state. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapStatusResponse"];
                    };
                };
                /** @description Malformed request. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Missing, invalid, expired, or wrong-scope swap token. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Swap token is valid but not scoped to this swap. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description No prepared swap or durable session found for the token. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Prepared transaction has expired. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Too many requests. */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Unexpected internal failure. */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/swap/sessions/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a wallet-scoped session list token
         * @description Verifies a short-lived EIP-712 wallet signature and returns a swap token that can list durable sessions and active prepared swaps for that source wallet.
         *
         *     Example viem payload to sign before calling this endpoint:
         *
         *     ```ts
         *     const signature = await walletClient.signTypedData({
         *       account,
         *       domain: {
         *         name: 'Radius Swap API',
         *         version: '1',
         *       },
         *       types: {
         *         SwapSessionListAccess: [
         *           { name: 'sourceAddress', type: 'address' },
         *           { name: 'expiresAt', type: 'uint256' },
         *           { name: 'environment', type: 'string' },
         *         ],
         *       },
         *       primaryType: 'SwapSessionListAccess',
         *       message: {
         *         sourceAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
         *         expiresAt: 1786233600n,
         *         environment: 'testnet',
         *       },
         *     });
         *     ```
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["SwapSessionListTokenRequest"];
                };
            };
            responses: {
                /** @description Wallet-scoped session list token returned. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapSessionListTokenResponse"];
                    };
                };
                /** @description Missing or malformed request field, invalid signature, or expired signature. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Missing, invalid, expired, or wrong-scope swap token. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Forbidden. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Requested swap state was not found. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Conflict. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Too many requests. */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Unexpected internal failure. */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/swap/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List wallet sessions and active prepared swaps
         * @description Lists durable swap sessions for the wallet authenticated by the session list token. Active prepared swaps are included on the first page by default and include a fresh prepared-scope swap token.
         */
        get: {
            parameters: {
                query?: {
                    limit?: string;
                    cursor?: string;
                    status?: "prepared" | "pending_broadcast" | "pending_deposit" | "processing" | "complete" | "failed" | "expired";
                    source_chain?: "base" | "base_sepolia" | "ethereum" | "sepolia" | "radius" | "radius_testnet";
                    tx_hash?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Wallet session list returned. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapSessionListResponse"];
                    };
                };
                /** @description Malformed query parameter. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Missing, invalid, expired, or wrong-scope swap token. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Forbidden. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Requested swap state was not found. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Conflict. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Too many requests. */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
                /** @description Unexpected internal failure. */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/swap/instructions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get machine-readable agent instructions
         * @description Returns a prompt-style guide that an LLM agent can ingest before preparing and broadcasting a swap.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Agent-facing usage instructions. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapInstructionsResponse"];
                    };
                };
                /** @description Unexpected internal failure. */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwapErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        UnsignedSwapTransaction: {
            /**
             * @description 0x-prefixed EVM address.
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            to: string;
            /**
             * @description ABI-encoded ERC-20 transfer calldata.
             * @example 0xa9059cbb00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
             */
            data: string;
            /**
             * @description ETH value for the transaction. Always 0x0 for ERC-20 transfers.
             * @example 0x0
             */
            value: string;
            /**
             * @description Numeric EVM chain ID used inside the unsigned transaction payload.
             * @example 8453
             */
            chainId: number;
            /**
             * @description Prepared transaction type.
             * @example legacy
             * @enum {string}
             */
            type: "legacy";
            /**
             * @description Pending nonce encoded as a hex quantity.
             * @example 0x7
             */
            nonce: string;
            /**
             * @description Estimated gas limit encoded as hex.
             * @example 0x186a0
             */
            gas: string;
            /**
             * @description Legacy gas price encoded as a hex quantity.
             * @example 0x3b9aca00
             */
            gasPrice: string;
        };
        PrepareSwapIntentResponse: {
            /**
             * @description Short-lived JWT scoped to a prepared swap, session status, or wallet session list.
             * @example eyJhbGciOiJIUzI1NiJ9.scaffold.payload
             */
            swap_token: string;
            /**
             * Format: date-time
             * @description UTC timestamp in ISO 8601 format.
             * @example 2026-05-07T01:00:00Z
             */
            swap_token_expires_at: string;
            /**
             * Format: date-time
             * @description UTC timestamp in ISO 8601 format.
             * @example 2026-05-07T01:00:00Z
             */
            prepared_tx_expires_at: string;
            /**
             * @description 0x-prefixed EVM address.
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            deposit_address: string;
            /**
             * @description 0x-prefixed EVM address.
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            deposit_token_address: string;
            /**
             * @description Supported Brale transfer type / public chain identifier.
             * @example base
             * @enum {string}
             */
            deposit_chain: "base" | "base_sepolia" | "ethereum" | "sepolia" | "radius" | "radius_testnet";
            /**
             * @description Supported public asset symbol.
             * @example USDC
             * @enum {string}
             */
            deposit_token: "USDC" | "SBC";
            /**
             * @description Supported Brale transfer type / public chain identifier.
             * @example base
             * @enum {string}
             */
            destination_chain: "base" | "base_sepolia" | "ethereum" | "sepolia" | "radius" | "radius_testnet";
            /**
             * @description Supported public asset symbol.
             * @example USDC
             * @enum {string}
             */
            destination_token: "USDC" | "SBC";
            /**
             * @description 0x-prefixed EVM address.
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            payout_token_address: string;
            /**
             * @description Decimal amount as a string.
             * @example 100.00
             */
            amount: string;
            unsigned_tx: components["schemas"]["UnsignedSwapTransaction"];
        };
        SwapErrorResponse: {
            error: {
                /**
                 * @description Stable machine-readable error code.
                 * @enum {string}
                 */
                code: "INVALID_REQUEST" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "UNSUPPORTED_CHAIN" | "UNSUPPORTED_TOKEN" | "UNSUPPORTED_ROUTE" | "INVALID_AMOUNT" | "INVALID_SIGNATURE" | "SIGNATURE_EXPIRED" | "IDEMPOTENCY_KEY_ALREADY_USED" | "ACTIVE_PREPARED_TX_EXISTS" | "INVALID_SIGNED_TX" | "TX_RECIPIENT_MISMATCH" | "TX_TOKEN_MISMATCH" | "TX_AMOUNT_MISMATCH" | "INSUFFICIENT_SOURCE_TOKEN" | "INSUFFICIENT_GAS" | "SOURCE_PREFLIGHT_FAILED" | "UNAUTHORIZED" | "TOKEN_EXPIRED" | "ADDRESS_BLOCKED" | "TOKEN_SESSION_MISMATCH" | "PREPARED_TX_NOT_FOUND" | "PREPARED_TX_EXPIRED" | "SESSION_NOT_FOUND" | "SESSION_EXPIRED" | "SESSION_ALREADY_BROADCAST" | "SESSION_NOT_CANCELLABLE" | "RATE_LIMITED" | "INTERNAL_ERROR";
                /** @description Human-readable explanation of the failure. */
                message: string;
                /**
                 * @description Matches the X-Request-Id response header; include it when reporting issues.
                 * @example req_b7c2f9d4-3d62-4f1e-9c3a-8a2f6f1f4b21
                 */
                request_id: string;
                /** @description Milliseconds to wait before retrying. Also exposed as the Retry-After header (seconds). */
                retry_after_ms?: number;
                /** @description Structured, code-specific context (e.g. challenge, tx_hash). */
                details?: {
                    [key: string]: unknown;
                };
            };
        };
        PrepareSwapIntentRequest: {
            /**
             * @description Public source chain name that will be embedded into the prepared typed data.
             * @example base_sepolia
             */
            source_chain: string;
            /**
             * @description Public source token symbol that will be embedded into the prepared typed data.
             * @example SBC
             */
            source_token: string;
            /**
             * @description Public destination chain name that selects the swap route.
             * @example radius_testnet
             */
            destination_chain: string;
            /**
             * @description Public destination token symbol that selects the swap route.
             * @example SBC
             */
            destination_token: string;
            /**
             * @description 0x-prefixed EVM address. Case is preserved from the original request for signature verification.
             * @example 0x742d35cc6634c0532925a3b844bc9e7595f2bd18
             */
            source_address: string;
            /**
             * @description 0x-prefixed EVM address. Case is preserved from the original request for signature verification.
             * @example 0x742d35cc6634c0532925a3b844bc9e7595f2bd18
             */
            destination_address: string;
            /**
             * @description Decimal amount as a string.
             * @example 100.00
             */
            amount: string;
            /**
             * @description Agent-provided idempotency key for the signed swap intent.
             * @example idem_01jv6e7av4pmk8m5ebj0x7xf82
             */
            idempotency_key: string;
            /**
             * @description Unix timestamp in seconds.
             * @example 1786233600
             */
            expires_at: number;
            /**
             * @description EIP-712 typed data signature.
             * @example 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
             */
            signature: string;
        };
        BroadcastSwapTransactionResponse: {
            /**
             * @description Opaque swap session identifier.
             * @example sess_abc123
             */
            session_id: string;
            /**
             * @description Short-lived JWT scoped to a prepared swap, session status, or wallet session list.
             * @example eyJhbGciOiJIUzI1NiJ9.scaffold.payload
             */
            swap_token: string;
            /**
             * Format: date-time
             * @description UTC timestamp in ISO 8601 format.
             * @example 2026-05-07T01:00:00Z
             */
            swap_token_expires_at: string;
            /**
             * @description 0x-prefixed transaction hash.
             * @example 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
             */
            tx_hash: string;
            /**
             * @description Swap session lifecycle status.
             * @example pending_deposit
             * @enum {string}
             */
            status: "pending_broadcast" | "pending_deposit" | "processing" | "complete" | "failed" | "expired";
        };
        BroadcastSwapTransactionRequest: {
            /**
             * @description Signed transaction bytes ready for broadcast.
             * @example 0xf8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
             */
            signed_tx: string;
        };
        SwapErrorDetails: {
            /**
             * @description Stable machine-readable error code.
             *
             *     | Code | When it fires | Caller action |
             *     | --- | --- | --- |
             *     | INVALID_REQUEST | The request body, path, query, or headers are missing required fields or failed validation. | Fix the request shape and retry. |
             *     | NOT_FOUND | No route matches the requested path. | Check the request path against the OpenAPI document. |
             *     | METHOD_NOT_ALLOWED | The HTTP method is not supported on this path. | Use a method from the Allow response header. |
             *     | UNSUPPORTED_CHAIN | The selected source or destination chain is not supported by the active swap environment. | Choose a chain from /instructions supported_routes and start a new prepare. |
             *     | UNSUPPORTED_TOKEN | The selected source or destination token is not supported by the active swap environment. | Choose a token from /instructions supported_routes and start a new prepare. |
             *     | UNSUPPORTED_ROUTE | The selected source chain, source token, destination chain, and destination token do not match a supported route. | Choose an exact route from /instructions supported_routes and start a new prepare. |
             *     | INVALID_AMOUNT | The amount is not a valid positive decimal amount for the selected source token. | Fix the amount and sign a new intent. |
             *     | INVALID_SIGNATURE | The EIP-712 signature does not match the submitted swap intent. | Rebuild the typed data exactly as documented, sign it again, and retry prepare. |
             *     | SIGNATURE_EXPIRED | The signed expires_at timestamp is in the past. | Create a new request with a future expiration, sign it, and retry. |
             *     | IDEMPOTENCY_KEY_ALREADY_USED | The idempotency_key was already consumed for this source wallet and chain. | Generate a new idempotency_key, sign a new swap intent, and retry prepare. |
             *     | ACTIVE_PREPARED_TX_EXISTS | A prepared transaction is already active for this source wallet and source chain. | Broadcast the existing prepared transaction, wait for it to expire, or retry prepare after it is consumed. |
             *     | INVALID_SIGNED_TX | The signed_tx is malformed or does not preserve a protected field from the prepared unsigned_tx. | Sign the exact unsigned_tx from the latest prepare response and retry broadcast. |
             *     | TX_RECIPIENT_MISMATCH | The signed transaction ERC-20 transfer recipient differs from the prepared deposit address. | Do not retry the same signed_tx. Re-sign the exact unsigned_tx, or start a new prepare if the intended route changed. |
             *     | TX_TOKEN_MISMATCH | The signed transaction target token contract differs from the prepared source token contract. | Do not retry the same signed_tx. Re-sign the exact unsigned_tx, or start a new prepare if the intended token changed. |
             *     | TX_AMOUNT_MISMATCH | The signed transaction ERC-20 transfer amount differs from the prepared amount. | Do not retry the same signed_tx. Re-sign the exact unsigned_tx, or start a new prepare if the intended amount changed. |
             *     | INSUFFICIENT_SOURCE_TOKEN | The source wallet does not have enough source token balance during prepare preflight. | Fund the source token balance or reduce the amount, then sign a new intent and retry prepare. |
             *     | INSUFFICIENT_GAS | The source wallet does not have enough native gas token for the prepared transaction. | Fund gas on the source chain, then sign a new intent and retry prepare. |
             *     | SOURCE_PREFLIGHT_FAILED | The source-chain RPC preflight failed while preparing nonce, gas, fees, or balance checks. | If the response is 500, retry prepare with the same intent before it expires. If it is 400, fix wallet or route state and sign a new intent. |
             *     | UNAUTHORIZED | The bearer swap_token is missing, invalid, or not scoped for the requested operation. | Use a current swap_token for this operation, or re-authenticate with the wallet to list sessions. |
             *     | TOKEN_EXPIRED | The bearer swap_token has expired. | For session status/listing, re-authenticate with the wallet. For unbroadcast prepared swaps, use listing to recover a fresh prepared swap_token or start a new prepare. |
             *     | ADDRESS_BLOCKED | The source wallet is blocked from using the swap API. | Stop retrying from this address and contact support if the block is unexpected. |
             *     | TOKEN_SESSION_MISMATCH | The bearer swap_token is valid but scoped to a different prepared swap or session. | Use the swap_token returned for the requested swap or re-authenticate with the wallet to list sessions. |
             *     | PREPARED_TX_NOT_FOUND | The prepared swap referenced by the swap_token is unknown, already consumed, or no longer active. | Use /swap/status or wallet session listing to recover the durable session if broadcast may have succeeded; otherwise start a new prepare. |
             *     | PREPARED_TX_EXPIRED | The prepared transaction expired before broadcast. | Start a new prepare. |
             *     | SESSION_NOT_FOUND | No durable swap session exists for the requested session_id. | Check the session_id or start a new prepare and broadcast flow. |
             *     | SESSION_EXPIRED | The durable swap session is past its polling or action window. | Stop polling this session and start a new prepare if the swap still needs to happen. |
             *     | SESSION_ALREADY_BROADCAST | The prepared transaction has already created a durable session. | Use the returned or listed session_id and continue polling it instead of broadcasting again. |
             *     | SESSION_NOT_CANCELLABLE | The session is already complete, failed, expired, or otherwise past the cancellable state. | Stop retrying cancel and inspect the session status. |
             *     | RATE_LIMITED | The caller exceeded the prepare request rate limit. | Wait for the retry window before sending another prepare request. |
             *     | INTERNAL_ERROR | The API hit an unexpected internal failure. | Retry later with backoff and include request_id if contacting support. |
             * @example SESSION_EXPIRED
             * @enum {string}
             */
            code: "INVALID_REQUEST" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "UNSUPPORTED_CHAIN" | "UNSUPPORTED_TOKEN" | "UNSUPPORTED_ROUTE" | "INVALID_AMOUNT" | "INVALID_SIGNATURE" | "SIGNATURE_EXPIRED" | "IDEMPOTENCY_KEY_ALREADY_USED" | "ACTIVE_PREPARED_TX_EXISTS" | "INVALID_SIGNED_TX" | "TX_RECIPIENT_MISMATCH" | "TX_TOKEN_MISMATCH" | "TX_AMOUNT_MISMATCH" | "INSUFFICIENT_SOURCE_TOKEN" | "INSUFFICIENT_GAS" | "SOURCE_PREFLIGHT_FAILED" | "UNAUTHORIZED" | "TOKEN_EXPIRED" | "ADDRESS_BLOCKED" | "TOKEN_SESSION_MISMATCH" | "PREPARED_TX_NOT_FOUND" | "PREPARED_TX_EXPIRED" | "SESSION_NOT_FOUND" | "SESSION_EXPIRED" | "SESSION_ALREADY_BROADCAST" | "SESSION_NOT_CANCELLABLE" | "RATE_LIMITED" | "INTERNAL_ERROR";
            /**
             * @description Human-readable explanation of the failure.
             * @example Session sess_abc123 has expired and can no longer accept a broadcast
             */
            message: string;
            /**
             * @description Request identifier for support/debugging.
             * @example req_xyz456
             */
            request_id: string;
        };
        SwapStatusResponse: {
            /**
             * @description Whether this item is still prepared in KV or has a durable D1 session.
             * @example session
             * @enum {string}
             */
            kind: "prepared" | "session";
            /**
             * @description Opaque swap session identifier.
             * @example sess_abc123
             */
            session_id?: string;
            /**
             * @description Prepared or durable swap lifecycle status.
             * @example prepared
             * @enum {string}
             */
            status: "prepared" | "pending_broadcast" | "pending_deposit" | "processing" | "complete" | "failed" | "expired";
            /**
             * @description Supported Brale transfer type / public chain identifier.
             * @example base
             * @enum {string}
             */
            source_chain?: "base" | "base_sepolia" | "ethereum" | "sepolia" | "radius" | "radius_testnet";
            /**
             * @description Supported public asset symbol.
             * @example USDC
             * @enum {string}
             */
            source_token?: "USDC" | "SBC";
            /**
             * @description 0x-prefixed EVM address.
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            source_address?: string;
            /**
             * @description 0x-prefixed EVM address.
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            destination_address?: string;
            /**
             * @description Supported Brale transfer type / public chain identifier.
             * @example base
             * @enum {string}
             */
            destination_chain?: "base" | "base_sepolia" | "ethereum" | "sepolia" | "radius" | "radius_testnet";
            /**
             * @description Supported public asset symbol.
             * @example USDC
             * @enum {string}
             */
            destination_token?: "USDC" | "SBC";
            /**
             * @description 0x-prefixed EVM address.
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            deposit_address?: string;
            /**
             * @description 0x-prefixed EVM address.
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            deposit_token_address?: string;
            /**
             * @description 0x-prefixed EVM address.
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            payout_token_address?: string;
            /**
             * @description Decimal amount as a string.
             * @example 100.00
             */
            amount?: string;
            unsigned_tx?: components["schemas"]["UnsignedSwapTransaction"];
            /**
             * Format: date-time
             * @description UTC timestamp in ISO 8601 format.
             * @example 2026-05-07T01:00:00Z
             */
            prepared_tx_expires_at?: string;
            /**
             * @description Short-lived JWT scoped to a prepared swap, session status, or wallet session list.
             * @example eyJhbGciOiJIUzI1NiJ9.scaffold.payload
             */
            swap_token?: string;
            /**
             * Format: date-time
             * @description UTC timestamp in ISO 8601 format.
             * @example 2026-05-07T01:00:00Z
             */
            swap_token_expires_at?: string;
            /**
             * @description 0x-prefixed transaction hash.
             * @example 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
             */
            tx_hash?: string;
            /**
             * @description 0x-prefixed transaction hash.
             * @example 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
             */
            payout_tx?: string;
            /**
             * Format: date-time
             * @description UTC timestamp in ISO 8601 format.
             * @example 2026-05-07T01:00:00Z
             */
            created_at?: string;
            /**
             * Format: date-time
             * @description UTC timestamp in ISO 8601 format.
             * @example 2026-05-07T01:00:00Z
             */
            updated_at?: string;
            /**
             * Format: date-time
             * @description UTC timestamp in ISO 8601 format.
             * @example 2026-05-07T01:00:00Z
             */
            completed_at?: string;
            error?: components["schemas"]["SwapErrorDetails"];
        };
        SwapSessionListTokenResponse: {
            /**
             * @description Short-lived JWT scoped to a prepared swap, session status, or wallet session list.
             * @example eyJhbGciOiJIUzI1NiJ9.scaffold.payload
             */
            swap_token: string;
            /**
             * Format: date-time
             * @description UTC timestamp in ISO 8601 format.
             * @example 2026-05-07T01:00:00Z
             */
            swap_token_expires_at: string;
        };
        SwapSessionListTokenRequest: {
            /**
             * @description 0x-prefixed EVM address. Case is preserved from the original request for signature verification.
             * @example 0x742d35cc6634c0532925a3b844bc9e7595f2bd18
             */
            source_address: string;
            /**
             * @description Unix timestamp in seconds.
             * @example 1786233600
             */
            expires_at: number;
            /**
             * @description EIP-712 typed data signature.
             * @example 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
             */
            signature: string;
        };
        SwapSessionListResponse: {
            items: components["schemas"]["SwapStatusResponse"][];
            next_cursor?: string;
        };
        SupportedSwapRoute: {
            /**
             * @description Supported Brale transfer type / public chain identifier.
             * @example base
             * @enum {string}
             */
            source_chain: "base" | "base_sepolia" | "ethereum" | "sepolia" | "radius" | "radius_testnet";
            /**
             * @description Supported public asset symbol.
             * @example USDC
             * @enum {string}
             */
            source_token: "USDC" | "SBC";
            /**
             * @description Supported Brale transfer type / public chain identifier.
             * @example base
             * @enum {string}
             */
            destination_chain: "base" | "base_sepolia" | "ethereum" | "sepolia" | "radius" | "radius_testnet";
            /**
             * @description Supported public asset symbol.
             * @example USDC
             * @enum {string}
             */
            destination_token: "USDC" | "SBC";
            /**
             * @description EVM chain ID of the source chain — use in the EIP-712 domain.
             * @example 84532
             */
            source_chain_id: number;
            /**
             * @description ERC-20 contract address for the source token on the source chain.
             * @example 0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16
             */
            source_token_contract: string;
            /**
             * @description Decimal precision of the source token — use to encode the amount.
             * @example 6
             */
            source_token_decimals: number;
            /**
             * @description EVM chain ID of the destination chain.
             * @example 72344
             */
            destination_chain_id: number;
            /**
             * @description ERC-20 contract address for the destination token on the destination chain.
             * @example 0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb
             */
            destination_token_contract: string;
            /**
             * @description Decimal precision of the destination token.
             * @example 6
             */
            destination_token_decimals: number;
        };
        SwapInstructionStep: {
            /** @example 1 */
            step: number;
            /** @example Sign an EIP-712 session request */
            name: string;
            /** @example Build the typed data payload and sign it with signTypedData. */
            description: string;
            signing_scheme?: string;
            typed_data_primary_type?: string;
            typed_data_domain_template?: {
                [key: string]: string;
            };
            typed_data_types?: {
                [key: string]: {
                    name: string;
                    type: string;
                }[];
            };
            typed_data_message_template?: {
                [key: string]: string;
            };
            viem_signing_example?: string;
            endpoint?: string;
            required_fields?: string[];
            required_headers?: {
                [key: string]: string;
            };
            key_response_fields?: string[];
            terminal_statuses?: ("pending_broadcast" | "pending_deposit" | "processing" | "complete" | "failed" | "expired")[];
        };
        SwapErrorCodeGuidance: {
            /**
             * @description Stable machine-readable error code.
             *
             *     | Code | When it fires | Caller action |
             *     | --- | --- | --- |
             *     | INVALID_REQUEST | The request body, path, query, or headers are missing required fields or failed validation. | Fix the request shape and retry. |
             *     | NOT_FOUND | No route matches the requested path. | Check the request path against the OpenAPI document. |
             *     | METHOD_NOT_ALLOWED | The HTTP method is not supported on this path. | Use a method from the Allow response header. |
             *     | UNSUPPORTED_CHAIN | The selected source or destination chain is not supported by the active swap environment. | Choose a chain from /instructions supported_routes and start a new prepare. |
             *     | UNSUPPORTED_TOKEN | The selected source or destination token is not supported by the active swap environment. | Choose a token from /instructions supported_routes and start a new prepare. |
             *     | UNSUPPORTED_ROUTE | The selected source chain, source token, destination chain, and destination token do not match a supported route. | Choose an exact route from /instructions supported_routes and start a new prepare. |
             *     | INVALID_AMOUNT | The amount is not a valid positive decimal amount for the selected source token. | Fix the amount and sign a new intent. |
             *     | INVALID_SIGNATURE | The EIP-712 signature does not match the submitted swap intent. | Rebuild the typed data exactly as documented, sign it again, and retry prepare. |
             *     | SIGNATURE_EXPIRED | The signed expires_at timestamp is in the past. | Create a new request with a future expiration, sign it, and retry. |
             *     | IDEMPOTENCY_KEY_ALREADY_USED | The idempotency_key was already consumed for this source wallet and chain. | Generate a new idempotency_key, sign a new swap intent, and retry prepare. |
             *     | ACTIVE_PREPARED_TX_EXISTS | A prepared transaction is already active for this source wallet and source chain. | Broadcast the existing prepared transaction, wait for it to expire, or retry prepare after it is consumed. |
             *     | INVALID_SIGNED_TX | The signed_tx is malformed or does not preserve a protected field from the prepared unsigned_tx. | Sign the exact unsigned_tx from the latest prepare response and retry broadcast. |
             *     | TX_RECIPIENT_MISMATCH | The signed transaction ERC-20 transfer recipient differs from the prepared deposit address. | Do not retry the same signed_tx. Re-sign the exact unsigned_tx, or start a new prepare if the intended route changed. |
             *     | TX_TOKEN_MISMATCH | The signed transaction target token contract differs from the prepared source token contract. | Do not retry the same signed_tx. Re-sign the exact unsigned_tx, or start a new prepare if the intended token changed. |
             *     | TX_AMOUNT_MISMATCH | The signed transaction ERC-20 transfer amount differs from the prepared amount. | Do not retry the same signed_tx. Re-sign the exact unsigned_tx, or start a new prepare if the intended amount changed. |
             *     | INSUFFICIENT_SOURCE_TOKEN | The source wallet does not have enough source token balance during prepare preflight. | Fund the source token balance or reduce the amount, then sign a new intent and retry prepare. |
             *     | INSUFFICIENT_GAS | The source wallet does not have enough native gas token for the prepared transaction. | Fund gas on the source chain, then sign a new intent and retry prepare. |
             *     | SOURCE_PREFLIGHT_FAILED | The source-chain RPC preflight failed while preparing nonce, gas, fees, or balance checks. | If the response is 500, retry prepare with the same intent before it expires. If it is 400, fix wallet or route state and sign a new intent. |
             *     | UNAUTHORIZED | The bearer swap_token is missing, invalid, or not scoped for the requested operation. | Use a current swap_token for this operation, or re-authenticate with the wallet to list sessions. |
             *     | TOKEN_EXPIRED | The bearer swap_token has expired. | For session status/listing, re-authenticate with the wallet. For unbroadcast prepared swaps, use listing to recover a fresh prepared swap_token or start a new prepare. |
             *     | ADDRESS_BLOCKED | The source wallet is blocked from using the swap API. | Stop retrying from this address and contact support if the block is unexpected. |
             *     | TOKEN_SESSION_MISMATCH | The bearer swap_token is valid but scoped to a different prepared swap or session. | Use the swap_token returned for the requested swap or re-authenticate with the wallet to list sessions. |
             *     | PREPARED_TX_NOT_FOUND | The prepared swap referenced by the swap_token is unknown, already consumed, or no longer active. | Use /swap/status or wallet session listing to recover the durable session if broadcast may have succeeded; otherwise start a new prepare. |
             *     | PREPARED_TX_EXPIRED | The prepared transaction expired before broadcast. | Start a new prepare. |
             *     | SESSION_NOT_FOUND | No durable swap session exists for the requested session_id. | Check the session_id or start a new prepare and broadcast flow. |
             *     | SESSION_EXPIRED | The durable swap session is past its polling or action window. | Stop polling this session and start a new prepare if the swap still needs to happen. |
             *     | SESSION_ALREADY_BROADCAST | The prepared transaction has already created a durable session. | Use the returned or listed session_id and continue polling it instead of broadcasting again. |
             *     | SESSION_NOT_CANCELLABLE | The session is already complete, failed, expired, or otherwise past the cancellable state. | Stop retrying cancel and inspect the session status. |
             *     | RATE_LIMITED | The caller exceeded the prepare request rate limit. | Wait for the retry window before sending another prepare request. |
             *     | INTERNAL_ERROR | The API hit an unexpected internal failure. | Retry later with backoff and include request_id if contacting support. |
             * @example SESSION_EXPIRED
             * @enum {string}
             */
            code: "INVALID_REQUEST" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "UNSUPPORTED_CHAIN" | "UNSUPPORTED_TOKEN" | "UNSUPPORTED_ROUTE" | "INVALID_AMOUNT" | "INVALID_SIGNATURE" | "SIGNATURE_EXPIRED" | "IDEMPOTENCY_KEY_ALREADY_USED" | "ACTIVE_PREPARED_TX_EXISTS" | "INVALID_SIGNED_TX" | "TX_RECIPIENT_MISMATCH" | "TX_TOKEN_MISMATCH" | "TX_AMOUNT_MISMATCH" | "INSUFFICIENT_SOURCE_TOKEN" | "INSUFFICIENT_GAS" | "SOURCE_PREFLIGHT_FAILED" | "UNAUTHORIZED" | "TOKEN_EXPIRED" | "ADDRESS_BLOCKED" | "TOKEN_SESSION_MISMATCH" | "PREPARED_TX_NOT_FOUND" | "PREPARED_TX_EXPIRED" | "SESSION_NOT_FOUND" | "SESSION_EXPIRED" | "SESSION_ALREADY_BROADCAST" | "SESSION_NOT_CANCELLABLE" | "RATE_LIMITED" | "INTERNAL_ERROR";
            /**
             * @description One-line description of when this error code fires.
             * @example The prepared transaction expired before broadcast.
             */
            description: string;
            /**
             * @description Recommended recovery action for agents and API clients.
             * @example Start a new prepare.
             */
            caller_action: string;
        };
        SwapInstructionsResponse: {
            /** @example 1 */
            version: string;
            /**
             * @description Resolved swap environment for this deployment — use as the EIP-712 message `environment` field.
             * @example testnet
             * @enum {string}
             */
            environment: "testnet" | "mainnet";
            overview: string;
            supported_routes: components["schemas"]["SupportedSwapRoute"][];
            steps: components["schemas"]["SwapInstructionStep"][];
            important_rules: string[];
            error_codes: components["schemas"]["SwapErrorCodeGuidance"][];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
