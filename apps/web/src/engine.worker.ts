import { fit } from "../../../packages/physics/index";
import { calculate, type Job, type Fitted, type Plan } from "./compute";
let bikes: Fitted[] = [];
let plan: Plan | undefined;
self.onmessage = (event: MessageEvent<Job>) => {
  const msg = event.data;
  if (msg.type === "fit") {
    bikes = msg.bikes.map((b) => ({
      id: b.id,
      model: fit(b.rows, b.mass, b.crr),
    }));
  } else plan = msg.plan;
  if (plan) self.postMessage(calculate(bikes, plan));
};
