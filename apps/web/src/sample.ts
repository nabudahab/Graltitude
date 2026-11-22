import {
  calm,
  watts,
  type Bike,
  type Ride,
} from "../../../packages/physics/index";
export const sampleBikes: Bike[] = [
  { id: "road", name: "Road bike", mass: 83 },
  { id: "gravel", name: "Gravel bike", mass: 86 },
];
const names = [
  "Ridgeline repeats",
  "Valley out-and-back",
  "Sunday club loop",
  "Morning on the flats",
  "Quarry ascent",
  "Lakeside tempo",
  "North ridge climb",
  "River road",
];
export const sampleRides: Ride[] = names.map((name, i) => {
  const bike = sampleBikes[i % 2],
    id = "sample-" + i,
    group = i === 2;
  return {
    id,
    name,
    bike: bike.id,
    date: new Date(Date.UTC(2026, 10, 20 - i)).toISOString(),
    distance: 21500 + i * 2900,
    group,
    windows: Array.from({ length: 4 }, (_, k) => {
      const speed = 5.7 + k * 1.55 + (i % 3) * 0.3,
        grade = [0.067, 0.034, 0.012, 0.002][k];
      const weather = {
        ...calm,
        wind: 1.3 + i * 0.08,
        direction: 20,
        gust: 2.5,
      };
      return {
        id: id + "-" + k,
        ride: id,
        speed,
        grade,
        watts:
          watts(
            speed,
            grade,
            bike.mass,
            i % 2 ? 0.37 : 0.305,
            i % 2 ? 0.007 : 0.004,
            125,
            weather,
          ) *
          (1 + 0.018 * Math.sin(k + i)),
        duration: 80,
        accel: 0,
        heading: 125,
        weather,
        flags: group ? ["Possible drafting"] : [],
      };
    }),
  };
});
