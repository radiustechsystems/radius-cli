export function SBCLogo() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      viewBox="0 0 400 400"
      shapeRendering="geometricPrecision"
      textRendering="geometricPrecision"
    >
      <style>{`
                @keyframes pulse1 {
                    0% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    12.5% { transform: translate(200px,200px) scale(0.41,0.41); }
                    25% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                    100% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                }
                @keyframes pulse2 {
                    0% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    8.333333% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    20.833333% { transform: translate(200px,200px) scale(0.41,0.41); }
                    33.333333% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                    100% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                }
                @keyframes pulse3 {
                    0% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    16.666667% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    29.166667% { transform: translate(200px,200px) scale(0.41,0.41); }
                    41.666667% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                    100% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                }
                @keyframes pulse4 {
                    0% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    25% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    37.5% { transform: translate(200px,200px) scale(0.41,0.41); }
                    50% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                    100% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                }
                @keyframes pulse5 {
                    0% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    33.333333% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    45.833333% { transform: translate(200px,200px) scale(0.41,0.41); }
                    58.333333% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                    100% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                }
                @keyframes pulse6 {
                    0% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    41.666667% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    54.166667% { transform: translate(200px,200px) scale(0.41,0.41); }
                    66.666667% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                    100% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                }
                @keyframes pulse7 {
                    0% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    50% { transform: translate(200px,200px) scale(0.454545,0.454542); }
                    62.5% { transform: translate(200px,200px) scale(0.41,0.41); }
                    75% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                    100% { transform: translate(200px,200px) scale(0.454545,0.454545); }
                }
                .sbc-circle1 { animation: pulse1 2400ms linear infinite; }
                .sbc-circle2 { animation: pulse2 2400ms linear infinite; }
                .sbc-circle3 { animation: pulse3 2400ms linear infinite; }
                .sbc-circle4 { animation: pulse4 2400ms linear infinite; }
                .sbc-circle5 { animation: pulse5 2400ms linear infinite; }
                .sbc-circle6 { animation: pulse6 2400ms linear infinite; }
                .sbc-circle7 { animation: pulse7 2400ms linear infinite; }
            `}</style>
      <g className="sbc-circle1" transform="translate(200,200) scale(0.454545,0.454542)">
        <circle r="440" fill="#6938ef" />
      </g>
      <g className="sbc-circle2" transform="translate(200,200) scale(0.454545,0.454542)">
        <circle r="385" fill="#8760f2" />
      </g>
      <g className="sbc-circle3" transform="translate(200,200) scale(0.454545,0.454542)">
        <circle r="330" fill="#a588f5" />
      </g>
      <g className="sbc-circle4" transform="translate(200,200) scale(0.454545,0.454542)">
        <circle r="275" fill="#c3aff9" />
      </g>
      <g className="sbc-circle5" transform="translate(200,200) scale(0.454545,0.454542)">
        <circle r="220" fill="#e1d7fc" />
      </g>
      <g className="sbc-circle6" transform="translate(200,200) scale(0.454545,0.454542)">
        <circle r="165" fill="#fff" />
      </g>
      <g className="sbc-circle7" transform="translate(200,200) scale(0.454545,0.454542)">
        <circle r="110" fill="#6938ef" />
      </g>
    </svg>
  );
}
