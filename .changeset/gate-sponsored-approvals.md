---
"radius-sdk": minor
"radius-cli": patch
---

`createRadiusFetch` no longer signs a facilitator-sponsored allowance change (`erc20ApprovalGasSponsoring`: a raw unlimited `approve` transaction; `eip2612GasSponsoring`: a permit) without asking. These now pass the same gate as the automatic Permit2 approval: `permit2Approval: 'never'` throws `approval_required`, and `onApprovalRequired` is called with `sponsored: 'erc20Approval' | 'eip2612'` and may decline. Sponsoring extensions that are not needed or not approved are withheld from the signing scheme, so it cannot sign one on its own, including when the allowance read fails. New `permit2ApprovalAmount` option bounds the automatic Permit2 approval (default `'unlimited'`, unchanged); a bounded amount also acts as a lifetime spend ceiling, since every Permit2 transfer lowers it. `wallet pay` words its prompt and non-interactive refusal for the sponsored case; `-y` and `--approve-permit2` still allow it.
