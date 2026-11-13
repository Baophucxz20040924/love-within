import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import type { PulseMoment } from '../../lib/types';
import { useCouplePeople } from '../questions/useCouplePeople';
import { CaptureButton, MomentTimer } from './MomentViews';

/**
 * Home card "Khoảnh khắc đang mở" (CP6, right after "Cần duyệt"): only while the prompt time has passed and I have not
 * posted. From the polled pulse (no request of its own); the 10-minute countdown ticks on the phone.
 */
export function MomentCard({ moment }: { moment: PulseMoment }) {
  const navigate = useNavigate();
  const { partnerName } = useCouplePeople();

  return (
    <section className="card mo-card" aria-labelledby="mo-card-title">
      <div className="row">
        <span className="icon-tile" aria-hidden="true">
          <Icon name="camera" />
        </span>
        <div className="grow">
          <h2 id="mo-card-title" className="card__title">
            Khoảnh khắc đang mở
          </h2>
          <MomentTimer windowEndsAt={moment.windowEndsAt} />
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
      </p>
      <CaptureButton className="btn btn-primary btn-block" onPosted={() => navigate('/moments')} />
    </section>
  );
}
