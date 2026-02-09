import classNames from "classnames";
import styles from "./ChevronIcon.module.scss";

export function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={classNames(styles.Icon, { [styles.Expanded]: expanded })}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 8.25l-7.5 7.5-7.5-7.5"
      />
    </svg>
  );
}
