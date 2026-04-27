import { Link, useNavigate } from "react-router-dom";
import { Button } from "../design";
import styles from "./NotFound.module.css";

export function NotFound() {
  const navigate = useNavigate();
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.code}>404</h1>
        <p className={styles.msg}>This route doesn't exist.</p>
        <div className={styles.actions}>
          <Button onClick={() => navigate(-1)} variant="ghost">← Back</Button>
          <Link to="/v2" style={{ textDecoration: "none" }}>
            <Button variant="primary">Dashboard</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
