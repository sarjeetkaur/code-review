import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useBlocker } from "react-router-dom";

export const useExitGuard = (hasChanges: boolean) => {
  const [showModal, setShowModal] = useState(false);
  const [nextLocation, setNextLocation] = useState(null);
  const navigate = useNavigate();
  const bypassRef = useRef(false);

  // Browser navigation
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasChanges) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasChanges]);

  useBlocker(({ nextLocation }) => {
    if (hasChanges && !bypassRef.current) {
      setNextLocation(nextLocation);
      setShowModal(true);
      return true;
    }
    return false;
  });

  const setBypass = useCallback((bypass: boolean) => {
    bypassRef.current = bypass;
  }, []);

  const handleConfirm = () => {
    bypassRef.current = true;
    setShowModal(false);
    navigate(nextLocation.pathname);
  };

  return { showModal, handleConfirm, setBypass };
};

// export const ExitGuardModal = ({ visible, onConfirm, onCancel }) => {
//   return (
//     <Modal open={visible} onCancel={onCancel} /* ... */>
//       <div>
//         <h3>Unsaved Changes</h3>
//         <p>You have unsaved changes. Are you sure you want to leave?</p>

//       </div>

//       <div>
//         <Button onClick={onCancel}>Stay on Page</Button>
//         <Button type="primary" danger onClick={onConfirm}>
//           Leave Anyway
//         </Button>
//       </div>
//     </Modal>
//   );
// };

// Timeline:
// T0: Click Link A → nextLocation = '/page-a', modal opens
// T1: Click Link B while modal open → nextLocation = '/page-b' (OVERWRITTEN!)
// T2: Click "Leave Anyway" → navigates to /page-b (WRONG!)
