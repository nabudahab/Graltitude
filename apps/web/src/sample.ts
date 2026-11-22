import {
  calm,
  watts,
  type Bike,
  type Ride,
  type Course,
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
  const whole = i >= 6;
  const distance = 21500 + i * 2900;
  return {
    id,
    name,
    bike: bike.id,
    date: new Date(Date.UTC(2026, 10, 20 - i)).toISOString(),
    distance,
    group,
    windows: Array.from({ length: whole ? 1 : 4 }, (_, k) => {
      const speed = 5.7 + k * 1.55 + (i % 3) * 0.3,
        grade = [0.067, 0.034, 0.012, 0.002][k];
      const weather = {
        ...calm,
        wind: 1.3 + i * 0.08,
        direction: 20,
        gust: 2.5,
      };
      return {
        id: whole ? id + ":whole" : id + "-" + k,
        label: whole ? "Whole ride" : "Lap " + (k + 1),
        legacyChoiceIds: whole
          ? [0, 1, 2, 3].map((n) => id + "-" + n)
          : undefined,
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
        duration: Math.round(distance / (whole ? 1 : 4) / speed),
        accel: 0,
        heading: 125,
        weather,
        flags: group ? ["Possible drafting"] : [],
      };
    }),
  };
});
export const exampleCourse: Course = {
  name: "Ridge ascent",
  located: false,
  points: Array.from({ length: 61 }, (_, i) => ({
    lat: 45 + i * 0.0009,
    lon: 7,
    z: 120 + 0.052 * i * 100 + 6 * Math.sin(i / 8),
    d: i * 100,
  })),
};
