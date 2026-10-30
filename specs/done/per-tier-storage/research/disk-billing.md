# Probe: exe.dev disk billing (provisioned vs consumed)

- 14 VMs, total provisioned capacity: 170.00 GB
- pool reports disk_used_bytes: 89.75 GB of 100.00 GB included
- disk_overage_bytes: 0.00 GB
- reported usage is 53% of provisioned capacity
- VERDICT: consumption-billed — provisioned capacity is a ceiling, only written blocks are charged.

### billing usage

```
{
  "avg_cpu_cores": 0.40544890635680114,
  "disk_overage_bytes": 0,
  "disk_used_bytes": 96367747072,
  "included_bandwidth_bytes": 214748364800,
  "included_disk_bytes": 107374182400,
  "max_cpus": 2,
  "period_end": "2026-08-12T15:17:07Z",
  "period_start": "2026-07-12T15:17:07Z",
  "range": "current billing cycle",
  "rx_bytes": 3189049084,
  "show_memory": false,
  "tx_bytes": 642321129,
  "tx_overage_bytes": 0,
  "vm_count": 14
}
```

### billing plan

```
{
  "bandwidth_gb": 200,
  "billing_period_end": "2026-08-12",
  "billing_status": "active",
  "cancel_at_period_end": false,
  "default_disk_gb": 25,
  "has_monthly_refresh": true,
  "managed_by": "Stripe",
  "max_cpus": 2,
  "max_disk_gb": 500,
  "max_memory_gb": 8,
  "max_vms": 50,
  "monthly_price_cents": 2000,
  "paid": true,
  "per_seat": false,
  "plan": "Individual",
  "plan_id": "individual:small:monthly:20260106",
  "pooled_disk_gb": 100,
  "provider": "stripe",
  "shelley_credits_max": 20,
  "status": "active",
  "status_label": "Active",
  "tier": "Small"
}
```

### Provisioned capacity per VM

```
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
workspace-redacted           10.00 GB
vmsyncrail-s09-reproof-30136               25.00 GB
Example User                                      25.00 GB
```
