-- Re-enable the existing native TRX deposit network after switching
-- monitoring to no-key solidified-block scanning.
UPDATE public.crypto_asset_networks
SET is_enabled = true
WHERE id = 'trx-tron'
  AND is_enabled = false;

-- Restore only the two addresses that were active immediately before the
-- temporary pause; do not reactivate any unrelated manually disabled address.
UPDATE public.user_deposit_addresses
SET address_status = 'active'
WHERE asset_network_id = 'trx-tron'
  AND id IN (
    '4a2ffeee-f39f-4e9d-9f52-de24d710bd44',
    '1fc3b0aa-7fe3-4dc1-bc13-6d8419b0ba98'
  )
  AND address_status = 'disabled';

NOTIFY pgrst, 'reload schema';
