// Generated from specs/faucet.openapi.json by scripts/generate-api.mjs (openapi-typescript). Do not edit.
// Radius Faucet API 1.0.0
export type paths = {
    "/api/v1/faucet/status/{address}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Check rate-limit status for an address */
        get: {
            parameters: {
                query?: {
                    token?: "SBC";
                };
                header?: never;
                path: {
                    address: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Rate limit status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["StatusResponse"];
                    };
                };
                /** @description Invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FaucetErrorResponse"];
                    };
                };
                /** @description Unexpected internal failure */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FaucetErrorResponse"];
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
    "/api/v1/faucet/challenge/{address}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the message to sign for authenticated drip requests
         * @description Returns the exact message string that must be signed with personal_sign (EIP-191) and included as `signature` in POST /drip. This allows agents to request tokens without knowing the message format in advance.
         */
        get: {
            parameters: {
                query?: {
                    token?: "SBC";
                };
                header?: never;
                path: {
                    address: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Challenge message */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ChallengeResponse"];
                    };
                };
                /** @description Invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FaucetErrorResponse"];
                    };
                };
                /** @description Unexpected internal failure */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FaucetErrorResponse"];
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
    "/api/v1/faucet/drip": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request testnet tokens for an address
         * @description To include a signature proving wallet ownership:
         *     1. GET /challenge/{address}?token=SBC to get the message
         *     2. Sign the message with personal_sign (EIP-191)
         *     3. POST /drip with { address, token, signature }
         *
         *     The signature is optional — unsigned requests are still accepted.
         *
         *     Where enabled, a small amount of native RUSD is sent alongside the token as a separate transaction, so the address has gas to move its new balance. It is reported under `native` in the response.
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
                    "application/json": components["schemas"]["DripRequest"];
                };
            };
            responses: {
                /** @description Drip successful */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DripSuccess"];
                    };
                };
                /** @description Invalid input, missing required signature, or invalid signature */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FaucetErrorResponse"];
                    };
                };
                /** @description Rate limited */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FaucetErrorResponse"];
                    };
                };
                /** @description Transaction error */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FaucetErrorResponse"];
                    };
                };
                /** @description Faucet unavailable, not configured, or low on funds */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FaucetErrorResponse"];
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
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        StatusResponse: {
            address: string;
            token: string;
            rate_limited: boolean;
            retry_after_ms: number | null;
            remaining_requests: number;
            drip_amount: string;
            /**
             * @description RUSD dripped alongside the token, in whole units. Null when the native drip is disabled.
             * @example 0.001
             */
            native_drip_amount: string | null;
            unlimited?: boolean;
        };
        FaucetErrorResponse: {
            error: {
                /**
                 * @description Stable machine-readable error code.
                 * @enum {string}
                 */
                code: "invalid_request" | "signature_required" | "invalid_signature" | "rate_limited" | "faucet_empty" | "sbc_not_configured" | "faucet_not_configured" | "transaction_reverted" | "receipt_timeout" | "native_drip_failed" | "not_found" | "method_not_allowed" | "internal_error";
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
        ChallengeResponse: {
            /** @description The exact message to sign with personal_sign (EIP-191). */
            message: string;
            address: string;
            token: string;
            /** @description Human-readable instructions for completing the drip request. */
            instructions: string;
        };
        /** @description The RUSD gas drip that accompanied the token transfer, so the address can afford to move its new balance. Absent when the native drip is disabled for this environment. */
        NativeDrip: {
            /**
             * @example RUSD
             * @enum {string}
             */
            token: "RUSD";
            /**
             * @description Native RUSD sent, in whole units.
             * @example 0.001
             */
            amount: string;
            /** @description Hash of the native RUSD transfer — a separate transaction from the SBC transfer. */
            tx_hash: string;
        };
        DripSuccess: {
            /** @enum {boolean} */
            success: true;
            address: string;
            token: string;
            amount: string;
            tx_hash: string;
            native?: components["schemas"]["NativeDrip"];
            next_drip_at?: number;
        };
        DripRequest: {
            /**
             * @description Ethereum address (0x-prefixed, 40 hex chars)
             * @example 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
             */
            address: string;
            /**
             * @default SBC
             * @example SBC
             * @enum {string}
             */
            token: "SBC";
            /**
             * @description EIP-191 signature proving wallet ownership. Get the message to sign from GET /challenge/{address}?token=SBC, then sign it with personal_sign.
             * @example 0xabcd...
             */
            signature?: string | null;
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
