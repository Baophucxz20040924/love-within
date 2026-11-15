import { useQuery } from '@tanstack/react-query';
import { WALLET_KEY, walletApi } from '../features/quests/api';
import { formatNumber } from '../lib/format';
import { ProgressBar } from './ProgressBar';

/** Small coin pill for page headers. */
export function CoinChip() {
  const wallet = useQuery({ queryKey: WALLET_KEY, queryFn: walletApi.get });
  if (!wallet.data) return null;
  return (
    <span className="coin-chip" aria-label={`Ví Xu của bạn: ${wallet.data.coinBalance} Xu`}>
      <span aria-hidden="true">🪙</span>
      {formatNumber(wallet.data.coinBalance)}
    </span>
  );
}

/** Personal coins; EXP and level remain shared by the couple. */
export function WalletCard() {
  const wallet = useQuery({ queryKey: WALLET_KEY, queryFn: walletApi.get });
  if (wallet.isLoading) return <div className="skeleton" style={{ height: 112 }} />;
  if (!wallet.data) return null;

  const w = wallet.data;
  const span = w.nextLevelExp !== null ? w.nextLevelExp - w.levelBaseExp : 0;
  const into = w.exp - w.levelBaseExp;
  const pct = w.nextLevelExp === null ? 100 : span > 0 ? (into / span) * 100 : 0;

  return (
    <div className="card wallet-card">
      <div className="row row--between">
        <div>
          <p className="text-sm text-muted">Ví Xu của bạn</p>
          <p className="wallet-card__coins">
            <span aria-hidden="true">🪙 </span>
            {formatNumber(w.coinBalance)} Xu
          </p>
        </div>
        <span className="level-badge">Cấp {w.level}</span>
      </div>
      <ProgressBar value={pct} label={`EXP cấp ${w.level}`} />
      <p className="text-sm text-muted num">
        {w.nextLevelExp === null
          ? `${formatNumber(w.exp)} EXP · cấp tối đa`
          : `${formatNumber(into)} / ${formatNumber(span)} EXP · còn ${formatNumber(w.nextLevelExp - w.exp)} EXP lên cấp ${w.level + 1}`}
      </p>
    </div>
  );
}
