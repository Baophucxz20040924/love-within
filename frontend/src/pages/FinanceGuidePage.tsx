import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { Page } from '../components/StatusViews';
import { FINANCE_CONNECTION_KEY, financeApi } from '../features/finance/api';
import { FinanceGuide } from '../features/finance/FinanceGuide';
import { LinkBankWizard } from '../features/finance/LinkBankWizard';

/** Always-available linking guide for every member of every couple. */
export function FinanceGuidePage() {
  const navigate = useNavigate();
  const conn = useQuery({ queryKey: FINANCE_CONNECTION_KEY, queryFn: financeApi.connection });
  const [wizardOpen, setWizardOpen] = useState(false);
  const linked = conn.data?.linked ?? false;

  return (
    <Page title="Hướng dẫn liên kết" subtitle="Dòng tiền từ MBBank qua thueapibank.vn" back="/finance">
      <FinanceGuide />
      {conn.data && !linked && (
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => setWizardOpen(true)}>
          <Icon name="creditCard" size={18} /> Liên kết ngân hàng
        </button>
      )}
      {linked && <p className="text-sm text-muted center">Bạn đã liên kết MBBank ••{conn.data?.accountLast4}.</p>}
      <LinkBankWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onLinked={() => navigate('/finance')} />
    </Page>
  );
}
