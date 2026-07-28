export const loginFormHtml = `
  <html>
    <body>
      <form method="post" action="/dkmh/login.asp">
        <input type="text" name="txtLoginId">
        <input type="password" name="txtPassword">
      </form>
    </body>
  </html>
`;

export const mixedAttributeLoginFormHtml = `
  <HTML>
    <BODY>
      <FORM ACTION='/dkmh/login.asp' METHOD="post">
        <INPUT NAME='TXTpassword' autocomplete="current-password" TYPE='password'>
        <INPUT data-purpose='login' TYPE="text" NaMe="TxtLoginID">
      </FORM>
    </BODY>
  </HTML>
`;

export const standaloneSessionEndedNoticeHtml = `
  <html>
    <body>
      <table><tr><td>
        Phi&#xEA;n l&#224;m vi&#7879;c &#273;&#227; k&#7871;t th&#250;c.
        Vui&nbsp;l&#242;ng &#273;&#259;ng nh&#7853;p l&#7841;i h&#7879; th&#7889;ng.
      </td></tr></table>
    </body>
  </html>
`;
