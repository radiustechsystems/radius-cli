---
'radius-sdk': patch
---

`radiusPayments` answers `502` (`facilitator_error`) when a facilitator call fails without the facilitator's own answer, such as a dropped connection or an error page from a gateway. These were reported as `402`, which a buyer reads as "rejected, nothing moved", although a settle may have reached the chain. The facilitator's own rejections are still `402`.
