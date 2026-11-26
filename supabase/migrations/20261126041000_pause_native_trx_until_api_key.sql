-- Temporarily stop accepting native TRX deposits until indexed monitoring
-- is authenticated with a TRON-PRO-API-KEY. Existing derivation/address records
-- remain intact and can be reactivated after the Edge Function secret is added.
UPDATE public.crypto_asset_networks
SET is_enabled = false
WHERE id = 'trx-tron';

UPDATE public.user_deposit_addresses
SET address_status = 'disabled'
WHERE asset_network_id = 'trx-tron'
  AND address_status = 'active';

NOTIFY pgrst, 'reload schema';
