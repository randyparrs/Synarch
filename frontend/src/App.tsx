import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { OverviewView } from './components/OverviewView';
import { AgentsView } from './components/AgentsView';
import { WorkflowsView } from './components/WorkflowsView';
import { EscrowView } from './components/EscrowView';
import { ReputationView } from './components/ReputationView';
import { HowItWorksView } from './components/HowItWorksView';
import { CreateWorkflowModal } from './components/CreateWorkflowModal';
import { useApp } from './context/AppContext';

export default function App() {
  const { view } = useApp();
  return (
    <>
      <div className="syn-app">
        <Sidebar />
        <main className="syn-main">
          <TopBar />
          <div className="syn-content">
            {view === 'overview' && <OverviewView />}
            {view === 'agents' && <AgentsView />}
            {view === 'workflows' && <WorkflowsView />}
            {view === 'escrow' && <EscrowView />}
            {view === 'reputation' && <ReputationView />}
            {view === 'how' && <HowItWorksView />}
          </div>
        </main>
      </div>
      <CreateWorkflowModal />
    </>
  );
}
