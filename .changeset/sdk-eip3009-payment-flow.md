---
"radius-sdk": patch
---

`radiusPayments` accepts facilitators that list the `eip3009` transfer method for `exact`. Previously every paid route answered 500 once the facilitator's `/supported` named `eip3009` before `permit2`.
