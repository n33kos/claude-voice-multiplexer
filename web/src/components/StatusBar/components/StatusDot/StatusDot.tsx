import classNames from "classnames";
import styles from "./StatusDot.module.scss";

export function StatusDot({ color }: { color: "green" | "yellow" | "red" }) {
  return (
    <div
      className={classNames(styles.Dot, {
        [styles.Green]: color === "green",
        [styles.Yellow]: color === "yellow",
        [styles.Red]: color === "red",
      })}
    />
  );
}
