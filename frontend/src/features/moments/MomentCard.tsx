import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import type { PulseMoment } from '../../lib/types';
import { useCouplePeople } from '../questions/useCouplePeople';
import { CaptureButton, MomentTimer, useMomentNow } from './MomentViews';

/** Home stays open until local midnight; only the 30-minute reward countdown expires earlier. */
export function MomentCard({ moment, onPendingChange }: { moment: PulseMoment; onPendingChange?: (pending: boolean) => void }) {
  const navigate = useNavigate();
  const { partnerName } = useCouplePeople();
  const now = useMomentNow(moment.closesAt, moment.rewardEndsAt);
  if (moment.scheduleVersion !== 3 || !moment.sessionId || !moment.closesAt || !moment.rewardEndsAt) return null;
  const visible = moment.state === 'open' && now < Date.parse(moment.closesAt);
  const rewardOpen = now < Date.parse(moment.rewardEndsAt);
  const target = { localDate: moment.localDate, sessionId: moment.sessionId };

  return (
    <section className={visible ? 'card mo-card' : undefined} aria-labelledby={visible ? 'mo-card-title' : undefined}>
      {visible && <><div className="row">
        <span className="icon-tile" aria-hidden="true">
          <Icon name="camera" />
        </span>
        <div className="grow">
          <h2 id="mo-card-title" className="card__title">
            Khoảnh khắc đang mở
          </h2>
          <MomentTimer rewardEndsAt={moment.rewardEndsAt} closesAt={moment.closesAt} />
        </div>
        <Link to="/moments" className="icon-btn mo-card__more" aria-label="Mở lịch Khoảnh khắc" title="Lịch Khoảnh khắc">
          <Icon name="calendar" />
        </Link>
      </div>
      <p className="mo-card__line">
        {moment.partnerPosted ? (
          <>
            <strong>{partnerName}</strong> đã chụp 🔒 Chụp để xem ảnh của {partnerName}
          </>
        ) : (
          'Chụp một tấm “mình đang làm gì” và xem ảnh của nhau.'
        )}
      </p></>}
      <CaptureButton key={moment.sessionId} target={target} closesAt={moment.closesAt} rewardEndsAt={moment.rewardEndsAt} available={visible} onPendingChange={onPendingChange}
        label={rewardOpen ? 'Chụp ngay' : 'Chụp giữ chuỗi'} className={`btn ${rewardOpen ? 'btn-primary' : 'btn-secondary'} btn-block`} onPosted={() => navigate('/moments')} />
    </section>
  );
}
