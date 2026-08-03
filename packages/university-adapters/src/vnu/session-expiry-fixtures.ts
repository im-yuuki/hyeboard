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

// Sanitized XHTML-only signature for the known paragraph expiry response.
// The anchor target is public portal routing; no captured markup or account
// data is represented here.
export const paragraphSessionEndedNoticeHtml = `
  <html xmlns="http://www.w3.org/1999/xhtml">
    <body>
      <p>
        Phi&#xEA;n l&#224;m vi&#7879;c &#273;&#227; k&#7871;t th&#250;c.<br />
        Vui&nbsp;l&#242;ng &#273;&#259;ng nh&#7853;p l&#7841;i h&#7879; th&#7889;ng.<br />
        <a href="https://daotao.vnu.edu.vn/dkmh/login.asp">Sign in</a>
        <br />
      </p>
    </body>
  </html>
`;

export const paragraphSessionEndedNoticeHttpHtml = paragraphSessionEndedNoticeHtml.replace(
  "https://daotao.vnu.edu.vn/dkmh/login.asp",
  "http://daotao.vnu.edu.vn/dkmh/login.asp",
);

// Sanitized XHTML-only signature for the VNU notification variant. It keeps
// the document shell intentionally exact so authenticated HTML cannot match.
// Structure matches the live response byte-for-byte: charset meta before the
// title, three <br> inside <p>, no trailing <br> before </p>.
// The pre-fix shape (no meta + trailing <br>) is still intentionally accepted
// for backward compatibility: the relaxed regex matches both variants.
export const xhtmlParagraphSessionEndedNoticeHttpHtml = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <title>Thông báo</title>
  </head>
  <body>
    <p>
      <br>
      Bạn chưa đăng nhập hoặc phiên làm việc của bạn đã hết<br><br>
      Xin vui lòng bấm <a href="http://daotao.vnu.edu.vn/dkmh/login.asp">vào đây</a> để đăng nhập lại
    </p>
  </body>
</html>
`;

export const xhtmlParagraphSessionEndedNoticeHttpsHtml = xhtmlParagraphSessionEndedNoticeHttpHtml.replace(
  "http://daotao.vnu.edu.vn/dkmh/login.asp",
  "https://daotao.vnu.edu.vn/dkmh/login.asp",
);
